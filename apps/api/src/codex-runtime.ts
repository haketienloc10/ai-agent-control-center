import type { AgentSession, LeadCommand, ModelSelection } from "@aacc/contracts";
import { CodexClient, type RpcMessage } from "./codex-client.js";
import { commandFromTool, leadDynamicTools } from "./lead-tools.js";

export interface AgentRunHooks {
  onThread(threadId: string): void;
  onTurn(turnId: string): void;
  onLeadTool?(callId: string, command: LeadCommand): Promise<string> | string;
}
export interface AgentRuntime {
  run(session: AgentSession, cwd: string, prompt: string, hooks: AgentRunHooks,
    selection?: ModelSelection, workspaceRoots?: string[]): Promise<string>;
}

/** Event-driven Codex turn; Lead actions use dynamic tools, never text/JSON envelopes. */
export class CodexAgentRuntime implements AgentRuntime {
  constructor(private readonly client: CodexClient) {
    this.client.on("serverRequest", (request: RpcMessage) => {
      if (request.method === "item/tool/call") return;
      if (request.id !== undefined) this.client.rejectServerRequest(request.id);
    });
  }

  async run(session: AgentSession, cwd: string, prompt: string, hooks: AgentRunHooks,
    selection: ModelSelection = {}, workspaceRoots?: string[]): Promise<string> {
    await this.client.start();
    const worker = session.role !== "lead";
    const safe = process.env.CODEX_SECURITY_MODE === "sandbox";
    const approvalPolicy = worker && safe ? "on-request" : "never";
    const sandbox = worker ? (safe ? "workspace-write" : "danger-full-access") : "read-only";
    // Discovery and Peer share the same execution policy. Only Discovery has multiple workspace roots.
    const roots = session.role === "discovery"
      ? [...new Set([cwd, ...(workspaceRoots ?? [])])]
      : [cwd];
    const sandboxPolicy = worker ? (safe
      ? { type: "workspaceWrite", writableRoots: roots, networkAccess: false }
      : { type: "dangerFullAccess" }) : { type: "readOnly" };

    const started: { thread: { id: string } } = session.threadId
      ? await this.client.request("thread/resume", { threadId: session.threadId, excludeTurns: true })
      : await this.client.request("thread/start", {
          cwd, approvalPolicy, sandbox,
          ...(session.role === "discovery" ? { runtimeWorkspaceRoots: roots } : {}),
          ...(selection.model ? { model: selection.model } : {}),
          ...(session.role === "lead" ? { dynamicTools: leadDynamicTools } : {})
        });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex không trả về thread.id");
    if (session.threadId && threadId !== session.threadId) {
      throw new Error("Codex resume returned unexpected thread.id");
    }
    hooks.onThread(threadId);

    let finish!: (status: string) => void;
    const finished = new Promise<string>(resolve => { finish = resolve; });
    let completed = false;
    const finishOnce = (status: string) => {
      if (!completed) { completed = true; finish(status); }
    };
    let runningTurnId: string | undefined;
    let earlyCompletion: { id: string; status: string } | undefined;
    let streaming = "";
    let finalText: string | undefined;
    const onEvent = (event: RpcMessage) => {
      if (event.params?.threadId !== threadId) return;
      if (event.params.turnId && runningTurnId && event.params.turnId !== runningTurnId) return;
      if (event.method === "item/agentMessage/delta" && typeof event.params.delta === "string") {
        streaming += event.params.delta;
      }
      if (event.method === "item/completed") {
        const item = event.params.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string") finalText = item.text;
      }
      if (event.method === "turn/completed" || event.method === "turn/failed") {
        const turn = event.params.turn as { id?: string; status?: string } | undefined;
        if (!turn?.id) return;
        const status = event.method === "turn/failed" ? "failed" : turn.status ?? "failed";
        if (!runningTurnId) earlyCompletion = { id: turn.id, status };
        else if (turn.id === runningTurnId) finishOnce(status);
      }
    };
    const onServerRequest = (event: RpcMessage) => {
      if (event.method !== "item/tool/call" || event.params?.threadId !== threadId ||
        event.id === undefined) return;
      const id = event.id;
      void (async () => {
        try {
          if (session.role !== "lead" || !hooks.onLeadTool) {
            throw new Error("Tool routing is available only to Lead");
          }
          const params = event.params!;
          const args = typeof params.arguments === "string"
            ? JSON.parse(params.arguments) as unknown : params.arguments;
          const command = commandFromTool(params.tool, args);
          const callId = params.callId;
          if (typeof callId !== "string" || !callId.trim()) throw new Error("Missing tool callId");
          const result = await hooks.onLeadTool(threadId + ":" + callId, command);
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
    try {
      const turn: { turn: { id: string } } = await this.client.request("turn/start", {
        threadId, input: [{ type: "text", text: prompt }],
        cwd, approvalPolicy,
        sandboxPolicy,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.effort ? { effort: selection.effort } : {})
      });
      if (!turn?.turn?.id) throw new Error("Codex không trả về turn.id");
      runningTurnId = turn.turn.id;
      hooks.onTurn(runningTurnId);
      if (earlyCompletion?.id === runningTurnId) finishOnce(earlyCompletion.status);
      // No arbitrary 10-minute timer: wait for the Codex terminal event or process exit.
      const status = await finished;
      if (status !== "completed") throw new Error("Codex turn status: " + status);
      return finalText ?? streaming;
    } finally {
      this.client.off("notification", onEvent);
      this.client.off("serverRequest", onServerRequest);
      this.client.off("exit", onExit);
    }
  }
}
