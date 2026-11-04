import type { AgentSession, LeadCommand } from "@aacc/contracts";
import { CodexClient, type RpcMessage } from "./codex-client.js";
import { commandFromTool, leadDynamicTools, legacyLeadOutputSchema } from "./lead-tools.js";

export interface AgentRunHooks {
  onThread(threadId: string): void;
  onTurn(turnId: string): void;
  onToolProtocol?(protocol: "dynamic" | "json"): void;
  onLeadTool?(callId: string, command: LeadCommand): Promise<string> | string;
  onToolUsed?(): void;
}
export interface AgentRuntime {
  run(session: AgentSession, cwd: string, prompt: string, hooks: AgentRunHooks): Promise<string>;
}

/** JSON-RPC transport: tool calls are executed by the host Coordinator, never by Peer. */
export class CodexAgentRuntime implements AgentRuntime {
  constructor(private readonly client: CodexClient) {
    this.client.on("serverRequest", (request: RpcMessage) => {
      // A matching Lead turn handles item/tool/call and responds with actual tool result.
      if (request.method === "item/tool/call") return;
      if (request.id !== undefined) this.client.rejectServerRequest(request.id);
    });
  }

  async run(session: AgentSession, cwd: string, prompt: string, hooks: AgentRunHooks): Promise<string> {
    await this.client.start();
    const peer = session.role === "peer";
    const safe = process.env.CODEX_SECURITY_MODE === "sandbox";
    const approvalPolicy = peer && safe ? "on-request" : "never";
    const sandbox = peer ? (safe ? "workspace-write" : "danger-full-access") : "read-only";
    const sandboxPolicy = peer ? (safe
      ? { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }
      : { type: "dangerFullAccess" }) : { type: "readOnly" };

    let protocol = session.toolProtocol ?? "json";
    let started: { thread: { id: string } };
    if (session.threadId) {
      // Codex persists dynamic tools at thread/start; old threads cannot install them
      // retroactively. The legacy path uses outputSchema for correct JSON escaping.
      started = await this.client.request("thread/resume", {
        threadId: session.threadId, excludeTurns: true
      });
    } else {
      const params = { cwd, approvalPolicy, sandbox };
      if (!peer) {
        try {
          started = await this.client.request("thread/start", {
            ...params, dynamicTools: leadDynamicTools
          });
          protocol = "dynamic";
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          // Retry without dynamic tools only for explicit unsupported-feature errors.
          // Never retry on RPC timeouts: the original thread may already exist.
          if (!/dynamicTools|dynamic_tools|experimentalApi|experimental.*(?:API|feature)|unknown field|unsupported.*tool|invalid params/i
            .test(reason)) throw error;
          started = await this.client.request("thread/start", params);
          protocol = "json";
        }
        hooks.onToolProtocol?.(protocol);
      } else {
        started = await this.client.request("thread/start", params);
      }
    }
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex không trả về thread.id");
    if (session.threadId && threadId !== session.threadId) {
      throw new Error("Codex resume returned unexpected thread.id");
    }
    hooks.onThread(threadId);

    let finish!: (status: string) => void;
    const finished = new Promise<string>(resolve => { finish = resolve; });
    let completed = false;
    const finishOnce = (status: string) => { if (!completed) { completed = true; finish(status); } };
    let streaming = "";
    let finalText: string | undefined;
    const onEvent = (event: RpcMessage) => {
      if (event.params?.threadId !== threadId) return;
      if (event.method === "item/agentMessage/delta" && typeof event.params.delta === "string") {
        streaming += event.params.delta;
      }
      if (event.method === "item/completed") {
        const item = event.params.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string") finalText = item.text;
      }
      if (event.method === "turn/completed") {
        finishOnce((event.params.turn as { status?: string } | undefined)?.status ?? "failed");
      }
    };
    const onServerRequest = (event: RpcMessage) => {
      if (event.method !== "item/tool/call" || event.params?.threadId !== threadId ||
        event.id === undefined) return;
      const id = event.id;
      // The event emitter does not await async listeners; settle the server request
      // explicitly, including tool-validation failures, to avoid hanging a Codex turn.
      void (async () => {
        try {
          if (peer || protocol !== "dynamic" || !hooks.onLeadTool) {
            throw new Error("Tool routing is available only to Lead");
          }
          const params = event.params!;
          const tool = params.tool;
          const args = typeof params.arguments === "string"
            ? JSON.parse(params.arguments) as unknown : params.arguments;
          const command = commandFromTool(tool, args);
          const callId = params.callId;
          if (typeof callId !== "string" || !callId.trim()) throw new Error("Missing tool callId");
          const result = await hooks.onLeadTool(threadId + ":" + callId, command);
          hooks.onToolUsed?.();
          this.client.respond(id, { success: true,
            contentItems: [{ type: "inputText", text: result }] });
        } catch (error) {
          this.client.respond(id, { success: false,
            contentItems: [{ type: "inputText", text: error instanceof Error
              ? error.message : String(error) }] });
        }
      })();
    };
    const onExit = () => finishOnce("failed");
    this.client.on("notification", onEvent);
    this.client.on("serverRequest", onServerRequest);
    this.client.on("exit", onExit);
    const timeout = setTimeout(() => finishOnce("timeout"), 10 * 60 * 1000);
    try {
      const base = {
        threadId, input: [{ type: "text", text: prompt }],
        cwd, approvalPolicy, sandboxPolicy
      };
      // Enforce valid JSON transport on pre-existing Lead sessions lacking dynamicTools.
      const structured = !peer && protocol !== "dynamic";
      let turn: { turn: { id: string } };
      try {
        turn = await this.client.request("turn/start",
          structured ? { ...base, outputSchema: legacyLeadOutputSchema } : base);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!structured || !/outputSchema|output schema|invalid params|unsupported.*schema/i.test(reason)) {
          throw error;
        }
        // Compatibility with older Codex app-server versions.
        turn = await this.client.request("turn/start", base);
      }
      if (!turn?.turn?.id) throw new Error("Codex không trả về turn.id");
      hooks.onTurn(turn.turn.id);
      const status = await finished;
      if (status !== "completed") throw new Error("Codex turn status: " + status);
      return finalText ?? streaming;
    } finally {
      clearTimeout(timeout);
      this.client.off("notification", onEvent);
      this.client.off("serverRequest", onServerRequest);
      this.client.off("exit", onExit);
    }
  }
}
