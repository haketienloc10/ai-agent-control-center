import type { WorkspaceConfig } from "@aacc/contracts";
import { createTask } from "./domain.js";
import type { CodexClient } from "./codex-client.js";
import { TaskStore } from "./store.js";
import { SessionManager } from "./session-manager.js";

/** Conservative recovery: reads persisted turns; never replays an uncertain tool action. */
export class RecoveryManager {
  constructor(
    private readonly config: WorkspaceConfig,
    private readonly store: TaskStore,
    private readonly codex: CodexClient,
    private readonly sessions: SessionManager
  ) {}

  async reconcile(taskId: string) {
    const task = this.store.get(taskId);
    if (!task || task.status !== "interrupted") throw new Error("Only interrupted tasks can be reconciled");
    if (!task.threadId || !task.turnId) {
      return this.store.update(taskId, {
        reconciliation: { status: "unknown", detail: "Missing persisted threadId/turnId; cannot confirm execution" }
      });
    }
    try {
      await this.codex.start();
      const [read, turns] = await Promise.all([
        this.codex.request<{ thread?: { status?: { type?: string } } }>("thread/read", {
          threadId: task.threadId
        }),
        this.codex.request<{ turns?: Array<{ id: string; status?: string }> }>("thread/turns/list", {
          threadId: task.threadId, limit: 100
        })
      ]);
      const turn = turns.turns?.find((t) => t.id === task.turnId);
      const terminal = turn?.status === "completed" || turn?.status === "failed" ||
        turn?.status === "interrupted";
      const active = read.thread?.status?.type === "active" || turn?.status === "inProgress";
      const reconciliation = active
        ? { status: "active" as const, detail: "Thread/Turn still active; do not replay" }
        : terminal
        ? { status: "completed" as const, detail: "Saved turn is terminal (" + turn?.status +
          "). Original task remains interrupted; manual continuation is safe only with a new prompt." }
        : { status: "unknown" as const, detail: "Cannot prove last turn completed; no automatic replay" };
      this.store.event(taskId, "recovery/reconciled", reconciliation);
      return this.store.update(taskId, { reconciliation });
    } catch (error) {
      return this.store.update(taskId, { reconciliation: {
        status: "unknown", detail: "Codex reconciliation unavailable: " + String(error)
      } });
    }
  }

  async reconcileAll() {
    for (const task of this.store.list().filter((t) => t.status === "interrupted" && !!t.threadId)) {
      await this.reconcile(task.id);
    }
  }

  /** User-initiated follow-up turn. Does NOT replay the original prompt or resume Workflow. */
  async continueTask(taskId: string, prompt: unknown) {
    const source = this.store.get(taskId);
    if (source?.role === "reviewer") {
      throw new Error("Final Reviewer never resumes a previous Thread; retry the workflow review");
    }
    if (!source || source.status !== "interrupted" ||
        source.reconciliation?.status !== "completed" || !source.threadId) {
      throw new Error("Must reconcile a terminal interrupted turn before starting a follow-up");
    }
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 10000) {
      throw new Error("Follow-up prompt must have 1-10000 characters");
    }
    // Original worktree is reused; source project is never targeted.
    if (source.role === "peer" && !source.executionCwd) throw new Error("Original isolated cwd is missing");
    const next = createTask({
      title: "Follow-up: " + source.title.slice(0, 160), role: source.role,
      ...(source.role === "peer" ? { moduleId: source.moduleId } : {}),
      prompt
    }, this.config);
    next.threadId = source.threadId;
    next.executionCwd = source.executionCwd;
    next.worktreeRoot = source.worktreeRoot;
    next.sourceRoot = source.sourceRoot;
    next.sourceModule = source.sourceModule;
    next.moduleRelative = source.moduleRelative;
    next.baseHead = source.baseHead;
    this.store.add(next);
    this.store.event(taskId, "recovery/continued", { followupTaskId: next.id });
    this.sessions.start(next.id);
    return next;
  }
}
