import type { RpcMessage } from "./codex-client.js";
import { CodexClient } from "./codex-client.js";
import { cwdForTask } from "./domain.js";
import type { WorktreeManager } from "./worktree-manager.js";
import { TaskStore } from "./store.js";
import type { Task, WorkspaceConfig } from "@aacc/contracts";

// Personal local workspace: equivalent to codex --yolo (no runtime approvals/sandbox).
// WARNING: cwd / module registry are routing hints, NOT filesystem boundaries in YOLO mode.
type ApprovalPolicy = "untrusted" | "on-request" | "granular" | "never";
// Preserve user's YOLO preference. Sandbox mode is an explicit opt-in.
const SAFE_MODE = process.env.CODEX_SECURITY_MODE === "sandbox";
const APPROVAL_POLICY: ApprovalPolicy = SAFE_MODE ? "on-request" : "never";
// Lead and Reviewer only coordinate/read. Only Peer gets write privileges.
const permission = (role: Task["role"], cwd: string) => role === "peer" ? {
  approvalPolicy: SAFE_MODE ? "on-request" : "never",
  sandbox: SAFE_MODE ? "workspace-write" : "danger-full-access",
  sandboxPolicy: SAFE_MODE
    ? { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }
    : { type: "dangerFullAccess" }
} : {
  approvalPolicy: "never",
  sandbox: "read-only",
  sandboxPolicy: { type: "readOnly" }
};

interface ThreadResult { thread: { id: string } }
interface TurnResult { turn: { id: string; status: string } }
interface QueueEntry {
  taskId: string;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
}

export interface AgentTaskExecutor {
  runAndWait(taskId: string): Promise<string>;
  prepare?(taskId: string): Promise<string>;
}

export class SessionManager implements AgentTaskExecutor {
  private readonly active = new Set<string>();
  private readonly queue: QueueEntry[] = [];
  private readonly pending = new Map<string, Promise<string>>();
  private readonly approvalRequests = new Map<string, { requestId: string | number; taskId: string }>();

  constructor(
    private readonly config: WorkspaceConfig,
    private readonly store: TaskStore,
    private readonly codex: CodexClient,
    private readonly concurrency = 2,
    private readonly worktrees?: WorktreeManager
  ) {
    codex.on("notification", (message: RpcMessage) => this.onNotification(message));
    codex.on("serverRequest", (message: RpcMessage) => this.onServerRequest(message));
  }

  // Manual UI: enqueue Task và trả về ngay. Workflow Engine dùng runAndWait để await output.
  start(taskId: string) {
    const task = this.store.get(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "queued" || this.pending.has(taskId)) {
      throw new Error("Chỉ chạy Task chưa được enqueue, trạng thái queued");
    }
    let resolve!: (output: string) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    // UI không await, nhưng cần handler để tránh unhandled rejection.
    void result.catch(() => undefined);
    this.pending.set(taskId, result);
    this.queue.push({ taskId, resolve, reject });
    this.drain();
    return this.store.get(taskId);
  }

  // Prepare worktree before collecting evidence. Calling twice reuses the same directory.
  async prepare(taskId: string): Promise<string> {
    const task = this.store.get(taskId);
    if (!task) throw new Error("Task not found");
    if (task.role !== "peer" || !this.worktrees) return cwdForTask(task, this.config);
    if (task.executionCwd) return task.executionCwd;
    const location = this.worktrees.ensure(task);
    this.store.update(task.id, {
      executionCwd: location.cwd, worktreeRoot: location.root,
      sourceRoot: location.sourceRoot, sourceModule: location.sourceModule,
      moduleRelative: location.moduleRelative, baseHead: location.baseHead
    });
    return location.cwd;
  }

  runAndWait(taskId: string): Promise<string> {
    this.start(taskId);
    return this.pending.get(taskId)!;
  }

  private drain(): void {
    while (this.active.size < this.concurrency && this.queue.length) {
      // Khoá ghi theo module áp dụng cho TẤT CẢ Task, kể cả các Workflow khác nhau.
      const next = this.queue.findIndex((entry) => {
        const candidate = this.store.get(entry.taskId);
        if (!candidate || candidate.role !== "peer") return true;
        return ![...this.active].some((id) => {
          const active = this.store.get(id);
          if (active?.role !== "peer") return false;
          if (active.moduleId === candidate.moduleId) return true;
          if (!this.worktrees) return false;
          try { return this.worktrees.sameRepository(active.moduleId, candidate.moduleId); }
          catch { return false; }
        });
      });
      if (next < 0) break;
      const entry = this.queue.splice(next, 1)[0];
      const task = this.store.get(entry.taskId);
      if (!task) { entry.reject(new Error("Task not found")); continue; }
      this.active.add(entry.taskId);
      this.store.update(task.id, {}, "starting");
      void this.execute(task).then(entry.resolve, (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        const current = this.store.get(entry.taskId);
        if (current && ["starting", "running", "waiting_runtime_approval"].includes(current.status)) {
          this.store.update(entry.taskId, { error: failure.message }, "failed");
        }
        this.store.event(entry.taskId, "runtime/error", { message: failure.message });
        entry.reject(failure);
      }).finally(() => {
        this.expirePending(entry.taskId);
        this.active.delete(entry.taskId);
        this.pending.delete(entry.taskId);
        this.drain();
      });
    }
  }

  private async execute(task: Task): Promise<string> {
    const cwd = await this.prepare(task.id);
    await this.codex.start();
    // Reviewer MUST always get a fresh Thread; no Lead/Peer conversational history.
    if (task.role === "reviewer" && task.threadId) {
      throw new Error("Reviewer cannot reuse a previous Codex Thread");
    }
    const policy = permission(task.role, cwd);
    const thread = task.threadId
      ? await this.codex.request<ThreadResult>("thread/resume", {
          threadId: task.threadId, excludeTurns: true
        })
      : await this.codex.request<ThreadResult>("thread/start", {
          cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox
        });
    if (!thread?.thread?.id) throw new Error("Codex thread/start did not return thread.id");
    this.store.update(task.id, { threadId: thread.thread.id });

    const prompt = task.role === "lead"
      ? "Bạn là Lead điều phối. Chỉ lập kế hoạch, review PeerResult, quyết định accept/rework, gỡ blocker bằng hướng dẫn. " +
        "Không tự sửa code hoặc đóng vai Final Reviewer.\n" +
        this.config.lead.instructions + "\n\nYêu cầu:\n" + task.prompt
      : task.role === "reviewer"
      ? "Bạn là Final Integration Reviewer ĐỘC LẬP trong fresh Codex Thread. " +
        "Chỉ đọc và xác minh sản phẩm, test evidence và integration contracts. " +
        "Không điều phối Peer, không sửa source, không dùng kết luận Lead làm bằng chứng thay cho kiểm tra.\n" +
        (this.config.reviewer?.instructions ?? "") + "\n\nYêu cầu:\n" + task.prompt
      : "Bạn là Peer Agent cho module " + task.moduleId +
        ". Chỉ thao tác trong worktree hiện tại. Không ghi vào source module gốc; P2 chỉ xuất patch sau duyệt. " +
        "Tuân thủ yêu cầu output và báo cáo test trung thực.\n\nYêu cầu:\n" + task.prompt;

    let finish!: (status: string) => void;
    const completed = new Promise<string>((resolve) => { finish = resolve; });
    let streamingText = "";
    let finalText: string | undefined;
    const onEvent = (msg: RpcMessage) => {
      if (msg.params?.threadId !== thread.thread.id) return;
      if (msg.method === "turn/completed") {
        finish((msg.params.turn as { status?: string } | undefined)?.status ?? "failed");
      }
      if (msg.method === "item/agentMessage/delta" && typeof msg.params.delta === "string") {
        streamingText += msg.params.delta;
      }
      if (msg.method === "item/completed") {
        const item = msg.params.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string") finalText = item.text;
      }
    };
    const onExit = () => finish("failed");
    this.codex.on("notification", onEvent);
    this.codex.on("exit", onExit);
    try {
      const turn = await this.codex.request<TurnResult>("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: prompt }],
        cwd, approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy
      });
      if (!turn?.turn?.id) throw new Error("Codex turn/start did not return turn.id");
      if (this.store.get(task.id)?.status === "starting") {
        this.store.update(task.id, { turnId: turn.turn.id }, "running");
      } else {
        this.store.update(task.id, { turnId: turn.turn.id });
      }
      const status = await completed;
      const current = this.store.get(task.id);
      const output = finalText ?? streamingText;
      if (current && ["running", "waiting_runtime_approval"].includes(current.status)) {
        if (status === "completed") this.store.update(task.id, { output }, "completed");
        else if (status === "interrupted") this.store.update(task.id, { output }, "interrupted");
        else this.store.update(task.id, { output, error: "Codex turn status: " + status }, "failed");
      }
      if (status !== "completed") throw new Error("Codex turn status: " + status);
      return output;
    } finally {
      this.codex.off("notification", onEvent);
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
    const current = this.store.get(task.id);
    if (current?.status === "starting") this.store.update(task.id, {}, "running");
    if (this.store.get(task.id)?.status === "running") this.store.update(task.id, {}, "waiting_runtime_approval");
  }
  decide(approvalId: string, decision: "accept" | "decline") {
    const request = this.approvalRequests.get(approvalId);
    const approval = this.store.approvals().find((item) => item.id === approvalId);
    if (!request || !approval || approval.status !== "pending") throw new Error("Approval không còn hiệu lực");
    this.codex.respond(request.requestId, { decision });
    this.approvalRequests.delete(approvalId);
    this.store.resolveApproval(approvalId, decision === "accept" ? "accepted" : "declined");
    const hasOtherPending = this.store.approvals().some((item) => item.taskId === request.taskId && item.status === "pending");
    if (this.store.get(request.taskId)?.status === "waiting_runtime_approval" && !hasOtherPending) {
      this.store.update(request.taskId, {}, "running");
    }
    return approval;
  }
  private expirePending(taskId: string) {
    for (const [id, req] of this.approvalRequests) {
      if (req.taskId === taskId) {
        try { this.codex.respond(req.requestId, { decision: "decline" }); } catch { /* app-server may have exited */ }
        this.approvalRequests.delete(id);
      }
    }
    this.store.expireApprovals(taskId);
  }
  async interrupt(taskId: string) {
    const task = this.store.get(taskId);
    if (!task?.threadId || !task.turnId || !this.active.has(taskId)) {
      throw new Error("Task không có Turn đang chạy");
    }
    await this.codex.request("turn/interrupt", { threadId: task.threadId, turnId: task.turnId });
    return this.store.get(taskId);
  }
}
