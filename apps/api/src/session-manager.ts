import type { RpcMessage } from "./codex-client.js";
import { CodexClient } from "./codex-client.js";
import { cwdForTask } from "./domain.js";
import { TaskStore } from "./store.js";
import type { Task, WorkspaceConfig } from "@aacc/contracts";

interface ThreadResult { thread: { id: string } }
interface TurnResult { turn: { id: string; status: string } }

export class SessionManager {
  private readonly active = new Set<string>();
  private readonly approvalRequests = new Map<string, { requestId: string | number; taskId: string }>();

  constructor(
    private readonly config: WorkspaceConfig,
    private readonly store: TaskStore,
    private readonly codex: CodexClient
  ) {
    codex.on("notification", (message: RpcMessage) => this.onNotification(message));
    codex.on("serverRequest", (message: RpcMessage) => this.onServerRequest(message));
    codex.on("exit", () => {
      for (const id of this.active) {
        const task = this.store.get(id);
        if (task && ["starting", "running", "waiting_runtime_approval"].includes(task.status)) {
          this.store.update(id, { error: "Codex app-server exited" }, "failed");
        }
      }
    });
  }

  start(taskId: string) {
    const task = this.store.get(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "queued") throw new Error("Chỉ chạy Task ở trạng thái queued");
    if (this.active.size >= 2) throw new Error("Đã đạt giới hạn 2 Task đang chạy");
    this.active.add(taskId);
    this.store.update(taskId, {}, "starting");
    void this.execute(task).catch((error: unknown) => {
      const current = this.store.get(taskId);
      if (current && ["starting", "running", "waiting_runtime_approval"].includes(current.status)) {
        this.store.update(taskId, { error: String(error) }, "failed");
      }
      this.store.event(taskId, "runtime/error", { message: String(error) });
    }).finally(() => {
      this.expirePending(taskId);
      this.active.delete(taskId);
    });
    return this.store.get(taskId);
  }

  private async execute(task: Task) {
    await this.codex.start();
    const cwd = cwdForTask(task, this.config);
    const thread = await this.codex.request<ThreadResult>("thread/start", {
      cwd, approvalPolicy: "onRequest", sandbox: "workspaceWrite"
    });
    if (!thread?.thread?.id) throw new Error("Codex thread/start did not return thread.id");
    this.store.update(task.id, { threadId: thread.thread.id });

    const prompt = task.role === "lead"
      ? this.config.lead.instructions + "\n\nYêu cầu:\n" + task.prompt
      : "Bạn là Peer Agent cho module " + task.moduleId +
        ". Chỉ sửa code trong module được giao; cung cấp bản tóm tắt, file thay đổi, test evidence, vấn đề tồn đọng.\n\nYêu cầu:\n" + task.prompt;

    // Theo dõi trước khi gọi turn/start để không mất completion nếu Turn kết thúc rất nhanh.
    let finish!: (status: string) => void;
    const completed = new Promise<string>((resolve) => { finish = resolve; });
    const onComplete = (msg: RpcMessage) => {
      if (msg.method === "turn/completed" && msg.params?.threadId === thread.thread.id) {
        finish((msg.params.turn as { status?: string } | undefined)?.status ?? "failed");
      }
    };
    const onExit = () => finish("failed");
    this.codex.on("notification", onComplete);
    this.codex.on("exit", onExit);
    try {
      const turn = await this.codex.request<TurnResult>("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: prompt }],
        cwd,
        approvalPolicy: "onRequest",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }
      });
      if (!turn?.turn?.id) throw new Error("Codex turn/start did not return turn.id");
      const current = this.store.get(task.id);
      if (current?.status === "starting") this.store.update(task.id, { turnId: turn.turn.id }, "running");
      const status = await completed;
      const currentAfter = this.store.get(task.id);
      if (!currentAfter || !["running", "waiting_runtime_approval"].includes(currentAfter.status)) return;
      if (status === "completed") this.store.update(task.id, {}, "completed");
      else if (status === "interrupted") this.store.update(task.id, {}, "interrupted");
      else this.store.update(task.id, { error: "Codex turn status: " + status }, "failed");
    } finally {
      this.codex.off("notification", onComplete);
      this.codex.off("exit", onExit);
    }
  }

  private taskForThread(threadId: unknown) {
    if (typeof threadId !== "string") return undefined;
    return [...this.active].map((id) => this.store.get(id)).find((task) => task?.threadId === threadId);
  }

  private onNotification(message: RpcMessage) {
    const task = this.taskForThread(message.params?.threadId);
    if (task) this.store.event(task.id, message.method ?? "unknown", message.params ?? {});
  }

  private onServerRequest(message: RpcMessage) {
    if (message.id === undefined) return;
    const task = this.taskForThread(message.params?.threadId);
    const supported = message.method === "item/commandExecution/requestApproval" ||
                      message.method === "item/fileChange/requestApproval";
    if (!task || !supported) {
      this.codex.rejectServerRequest(message.id, "Unsupported or unowned Codex request");
      return;
    }
    const approval = this.store.addApproval({
      taskId: task.id, requestId: message.id, method: message.method!, params: message.params ?? {}
    });
    this.approvalRequests.set(approval.id, { taskId: task.id, requestId: message.id });
    if (task.status === "running") this.store.update(task.id, {}, "waiting_runtime_approval");
  }

  decide(approvalId: string, decision: "accept" | "decline") {
    const request = this.approvalRequests.get(approvalId);
    const approval = this.store.approvals().find((item) => item.id === approvalId);
    if (!request || !approval || approval.status !== "pending") throw new Error("Approval không còn hiệu lực");
    this.codex.respond(request.requestId, { decision });
    this.approvalRequests.delete(approvalId);
    this.store.resolveApproval(approvalId, decision === "accept" ? "accepted" : "declined");
    const task = this.store.get(request.taskId);
    const hasOtherPending = this.store.approvals().some((item) => item.taskId === request.taskId && item.status === "pending");
    if (task?.status === "waiting_runtime_approval" && !hasOtherPending) {
      this.store.update(task.id, {}, "running");
    }
    return approval;
  }

  private expirePending(taskId: string) {
    for (const [id, request] of this.approvalRequests) {
      if (request.taskId === taskId) this.approvalRequests.delete(id);
    }
    this.store.expireApprovals(taskId);
  }

  async interrupt(taskId: string) {
    const task = this.store.get(taskId);
    if (!task?.threadId || !task.turnId || !this.active.has(taskId)) throw new Error("Task không có Turn đang chạy");
    await this.codex.request("turn/interrupt", { threadId: task.threadId, turnId: task.turnId });
    return this.store.get(taskId);
  }
}
