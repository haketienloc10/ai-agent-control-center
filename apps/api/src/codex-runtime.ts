import type { AgentSession } from "@aacc/contracts";
import { CodexClient, type RpcMessage } from "./codex-client.js";

export interface AgentRuntime {
  run(session: AgentSession, cwd: string, prompt: string,
    hooks: { onThread(threadId: string): void; onTurn(turnId: string): void }): Promise<string>;
}

/** Codex app-server is only a transport. It never chooses a Peer or reviews quality. */
export class CodexAgentRuntime implements AgentRuntime {
  constructor(private readonly client: CodexClient) {
    this.client.on("serverRequest", (request: RpcMessage) => {
      if (request.id !== undefined) this.client.rejectServerRequest(request.id);
    });
  }
  async run(session: AgentSession, cwd: string, prompt: string,
    hooks: { onThread(threadId: string): void; onTurn(turnId: string): void }): Promise<string> {
    await this.client.start();
    const peer = session.role === "peer";
    const safe = process.env.CODEX_SECURITY_MODE === "sandbox";
    const approvalPolicy = peer && safe ? "on-request" : "never";
    const sandbox = peer ? (safe ? "workspace-write" : "danger-full-access") : "read-only";
    const sandboxPolicy = peer ? (safe
      ? { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }
      : { type: "dangerFullAccess" }) : { type: "readOnly" };
    const started = await this.client.request<{ thread: { id: string } }>(
      session.threadId ? "thread/resume" : "thread/start",
      session.threadId ? { threadId: session.threadId, excludeTurns: true }
        : { cwd, approvalPolicy, sandbox }
    );
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
    const onExit = () => finishOnce("failed");
    this.client.on("notification", onEvent);
    this.client.on("exit", onExit);
    const timeout = setTimeout(() => finishOnce("timeout"), 10 * 60 * 1000);
    try {
      const turn = await this.client.request<{ turn: { id: string } }>("turn/start", {
        threadId, input: [{ type: "text", text: prompt }],
        cwd, approvalPolicy, sandboxPolicy
      });
      if (!turn?.turn?.id) throw new Error("Codex không trả về turn.id");
      hooks.onTurn(turn.turn.id);
      const status = await finished;
      if (status !== "completed") throw new Error("Codex turn status: " + status);
      return finalText ?? streaming;
    } finally {
      clearTimeout(timeout);
      this.client.off("notification", onEvent);
      this.client.off("exit", onExit);
    }
  }
}
