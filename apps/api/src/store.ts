import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActivityEntry, ActivityEvent, NotificationEntry, RuntimeApproval, SessionHistoryItem,
  SessionHistoryPage, JournalPage, Task, TaskStatus, WorkflowRun } from "@aacc/contracts";
import { projectActivity } from "./activity.js";
import { assertTransition } from "./domain.js";

interface Persisted {
  tasks: Task[];
  events: ActivityEvent[];
  approvals: RuntimeApproval[];
  workflows: WorkflowRun[];
  activities: ActivityEntry[];
  notifications: NotificationEntry[];
}

export class TaskStore extends EventEmitter {
  private readonly file: string;
  private readonly db: DatabaseSync;
  private state: Persisted;
  private streamFlush?: NodeJS.Timeout;
  private pendingJournal: ActivityEvent[] = [];

  constructor(dataDir: string) {
    super();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, "state.json");
    this.db = new DatabaseSync(join(dataDir, "state.sqlite"), { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);");
    this.db.exec("CREATE TABLE IF NOT EXISTS event_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);");
    this.db.exec("CREATE INDEX IF NOT EXISTS event_task_seq ON event_journal(task_id,seq);");
    this.db.exec("CREATE INDEX IF NOT EXISTS event_kind_seq ON event_journal(kind,seq);");
    const saved = this.db.prepare("SELECT json FROM snapshots WHERE id=1").get() as { json: string } | undefined;
    const raw = saved ? JSON.parse(saved.json) as Partial<Persisted> : existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted> : {};
    if (!saved && raw.events?.length) this.pendingJournal = [...raw.events];
    this.state = {
      tasks: raw.tasks ?? [], events: raw.events ?? [],
      approvals: raw.approvals ?? [], workflows: raw.workflows ?? [],
      activities: raw.activities ?? [], notifications: raw.notifications ?? []
    };
    // Migrate legacy raw event journal into readable timeline once.
    if (!raw.activities) {
      for (const event of this.state.events) projectActivity(this.state.activities, event);
    }
    // Không chạy lại Task/Workflow tự động sau restart vì có thể sinh side effect trùng.
    for (const task of this.state.tasks) {
      if (["starting", "running", "waiting_runtime_approval"].includes(task.status)) {
        task.status = "interrupted";
        task.error = "Backend restarted; reconcile thread before retry";
        task.updatedAt = new Date().toISOString();
        task.finishedAt = task.updatedAt;
        this.notify("task", task.id, "task_interrupted", "Task gián đoạn sau restart",
          task.title + ": " + task.error);
      }
    }
    // Migrate legacy failed/interrupted workflows with orphaned queued Tasks.
    // A queued Task has not started a Codex turn; cancelling it is side-effect free.
    // Heal P2-era persisted dirty-Git failures without touching source files
    // or changing retryable review failures.
    for (const workflow of this.state.workflows) {
      if (workflow.status !== "failed") continue;
      const pathMatch = /^Source repository has uncommitted\/untracked files; commit or clean before P2 isolation: (.+)$/m
        .exec(workflow.error ?? "");
      if (!pathMatch) continue;
      workflow.failureHint ??= { code: "dirty_source", path: pathMatch[1].trim() };
      for (const peer of workflow.peers) {
        if (peer.status === "running") {
          peer.status = "failed";
          peer.feedback ??= workflow.error;
        } else if (["pending", "rework", "review_pending"].includes(peer.status)) {
          peer.status = "skipped";
          peer.feedback ??= "Workflow đã dừng trước khi Peer được thực thi/duyệt: " + workflow.error;
        }
      }
    }
    const terminalWorkflows = new Set(this.state.workflows
      .filter(w => ["failed", "rejected", "completed", "interrupted", "blocked"].includes(w.status))
      .map(w => w.id));
    for (const task of this.state.tasks) {
      if (task.status === "queued" && task.workflowId && terminalWorkflows.has(task.workflowId)) {
        task.status = "cancelled";
        task.error = "Workflow already terminated before this Task started";
        task.updatedAt = new Date().toISOString();
        task.finishedAt = task.updatedAt;
      }
    }
    for (const approval of this.state.approvals) {
      if (approval.status === "pending") approval.status = "expired";
    }
    for (const workflow of this.state.workflows) {
      if (["planning", "executing", "reviewing", "integration_reviewing"].includes(workflow.status)) {
        workflow.status = "interrupted";
        workflow.error = "Backend restarted; do not auto-dispatch without reconciliation";
        workflow.updatedAt = new Date().toISOString();
        this.notify("workflow", workflow.id, "workflow_interrupted",
          "Workflow gián đoạn sau restart", workflow.title + ": " + workflow.error);
      }
    }
    this.save();
  }

  private save() {
    if (this.streamFlush) { clearTimeout(this.streamFlush); this.streamFlush = undefined; }
    const json = JSON.stringify(this.state);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO snapshots(id,json) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(json);
      const statement = this.db.prepare("INSERT OR IGNORE INTO event_journal(id,task_id,kind,data,created_at) VALUES(?,?,?,?,?)");
      for (const item of this.pendingJournal) {
        statement.run(item.id, item.taskId, item.kind, JSON.stringify(item.data), item.createdAt);
      }
      this.db.exec("COMMIT");
      this.pendingJournal = [];
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    // Compatibility view only. SQLite is authoritative on subsequent boot.
    const temp = this.file + ".tmp";
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  close() {
    if (this.streamFlush) { clearTimeout(this.streamFlush); this.streamFlush = undefined; }
    this.save();
    this.db.close();
  }

  private flushStreamSoon() {
    if (this.streamFlush) return;
    this.streamFlush = setTimeout(() => {
      this.streamFlush = undefined;
      this.save();
      this.emit("change");
    }, 250);
  }

  list() { return [...this.state.tasks].reverse(); }
  events() { return this.state.events.slice(-150); }
  journal(afterSeq = 0, limit = 100) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Invalid journal pagination");
    }
    return this.db.prepare(
      "SELECT seq, id, task_id AS taskId, kind, data, created_at AS createdAt FROM event_journal WHERE seq>? ORDER BY seq LIMIT ?"
    ).all(afterSeq, limit).map((row) => ({
      seq: Number(row.seq), id: row.id as string, taskId: row.taskId as string,
      kind: row.kind as string, data: JSON.parse(row.data as string),
      createdAt: row.createdAt as string
    }));
  }
  activities() { return this.state.activities.slice(-300); }
  notifications() { return [...this.state.notifications].reverse(); }
  unreadNotifications() { return this.state.notifications.filter(item => !item.readAt).length; }
  acknowledge(id: string) {
    const alert = this.state.notifications.find(n => n.id === id);
    if (!alert) throw new Error("Notification not found");
    if (!alert.readAt) {
      alert.readAt = new Date().toISOString();
      this.save(); this.emit("change");
    }
    return alert;
  }

  /** Cursor is the last returned task ID in newest-first persisted order. */
  sessions(query: { limit?: number; cursor?: string; role?: string; status?: string;
    workflowId?: string } = {}): SessionHistoryPage {
    const limit = query.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid session history limit");
    }
    if (query.role && !["lead", "peer", "reviewer"].includes(query.role)) {
      throw new Error("Invalid session role");
    }
    if (query.status && !["queued", "starting", "running", "waiting_runtime_approval",
      "completed", "failed", "interrupted", "cancelled"].includes(query.status)) {
      throw new Error("Invalid session status");
    }
    const filtered = this.list().filter(t => (!query.role || t.role === query.role) &&
      (!query.status || t.status === query.status) &&
      (!query.workflowId || t.workflowId === query.workflowId));
    const start = query.cursor ? filtered.findIndex(t => t.id === query.cursor) + 1 : 0;
    if (query.cursor && start === 0) throw new Error("Invalid or stale session cursor");
    const page = filtered.slice(start, start + limit);
    return {
      items: page.map((t): SessionHistoryItem => ({
        id: t.id, role: t.role, title: t.title, moduleId: t.moduleId, workflowId: t.workflowId,
        threadId: t.threadId, turnId: t.turnId, status: t.status,
        createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
        updatedAt: t.updatedAt,
        ...(t.startedAt && t.finishedAt ? {
          durationMs: Math.max(0, new Date(t.finishedAt).getTime() -
            new Date(t.startedAt).getTime())
        } : {})
      })),
      ...(start + limit < filtered.length ? { nextCursor: page.at(-1)!.id } : {})
    };
  }

  /** Durable journal cursor with optional query filters; capped before returning. */
  journalPage(query: { before?: number; limit?: number; taskId?: string;
    kind?: string; search?: string } = {}): JournalPage {
    const before = query.before ?? Number.MAX_SAFE_INTEGER;
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > 100) throw new Error("Invalid journal pagination");
    if (query.taskId && query.taskId.length > 128 ||
        query.kind && query.kind.length > 128 ||
        query.search && query.search.length > 120) throw new Error("Invalid journal filter");
    const where = ["seq < ?"];
    const params: (string | number)[] = [before];
    if (query.taskId) { where.push("task_id = ?"); params.push(query.taskId); }
    if (query.kind) { where.push("kind LIKE ? ESCAPE '\\'"); params.push(
      query.kind.replace(/[\\%_]/g, match => "\\" + match) + "%"); }
    if (query.search) { where.push("instr(lower(data), lower(?)) > 0"); params.push(query.search); }
    const rows = this.db.prepare(
      "SELECT seq,id,task_id AS taskId,kind,data,created_at AS createdAt FROM event_journal WHERE " +
      where.join(" AND ") + " ORDER BY seq DESC LIMIT ?"
    ).all(...params, limit + 1);
    const items = rows.slice(0, limit).map(row => ({
      seq: Number(row.seq), id: row.id as string, taskId: row.taskId as string,
      kind: row.kind as string, data: JSON.parse(row.data as string), createdAt: row.createdAt as string
    }));
    return { items, ...(rows.length > limit ? { nextCursor: items.at(-1)!.seq } : {}) };
  }

  private notify(scope: NotificationEntry["scope"], targetId: string,
    kind: NotificationEntry["kind"], title: string, message: string) {
    const notification: NotificationEntry = {
      id: randomUUID(), scope, targetId, kind, title,
      message: message.slice(0, 600), createdAt: new Date().toISOString()
    };
    this.state.notifications.push(notification);
    if (this.state.notifications.length > 500) {
      this.state.notifications.splice(0, this.state.notifications.length - 500);
    }
  }
  eventsForTask(taskId: string) { return this.state.events.filter((event) => event.taskId === taskId); }
  approvals() { return [...this.state.approvals].reverse(); }
  workflows() { return [...this.state.workflows].reverse(); }
  get(id: string) { return this.state.tasks.find((task) => task.id === id); }
  getWorkflow(id: string) { return this.state.workflows.find((workflow) => workflow.id === id); }

  add(task: Task) {
    this.state.tasks.push(task);
    this.save(); this.emit("change");
    return task;
  }
  update(id: string, patch: Partial<Task>, status?: TaskStatus) {
    const task = this.get(id);
    if (!task) throw new Error("Task not found");
    if (status) { assertTransition(task.status, status); task.status = status; }
    const now = new Date().toISOString();
    Object.assign(task, patch, { updatedAt: now });
    if (status === "starting" && !task.startedAt) task.startedAt = now;
    if (status && ["completed", "failed", "interrupted", "cancelled"].includes(status)) {
      task.finishedAt = now;
      if (status === "failed" || status === "interrupted") {
        this.notify("task", id, status === "failed" ? "task_failed" : "task_interrupted",
          status === "failed" ? "Task thất bại" : "Task gián đoạn",
          task.title + (task.error ? ": " + task.error : ""));
      }
    }
    if (status) {
      const event: ActivityEvent = {
        id: randomUUID(), taskId: id, kind: "task/status",
        data: { status, error: patch.error }, createdAt: task.updatedAt
      };
      projectActivity(this.state.activities, event);
      this.state.events.push(event);
      this.state.events = this.state.events.slice(-1000);
      this.pendingJournal.push(event);
    }
    this.save(); this.emit("change");
    return task;
  }
  event(taskId: string, kind: string, data: unknown) {
    const event: ActivityEvent = { id: randomUUID(), taskId, kind, data, createdAt: new Date().toISOString() };
    projectActivity(this.state.activities, event);
    // Streaming fragments are represented by a single aggregated ActivityEntry.
    // Do not flood the raw journal with a JSON event for every token.
    const streaming = kind === "item/agentMessage/delta" || kind === "item/commandExecution/outputDelta";
    if (streaming) {
      this.flushStreamSoon();
    } else {
      this.state.events.push(event);
      this.state.events = this.state.events.slice(-1000);
      this.pendingJournal.push(event);
      this.save(); this.emit("change");
    }
    return event;
  }
  workflowEvent(workflowId: string, kind: string, data: unknown) {
    return this.event("workflow:" + workflowId, kind, data);
  }
  addWorkflow(workflow: WorkflowRun) {
    this.state.workflows.push(workflow);
    this.save(); this.emit("change");
    return workflow;
  }
  mutateWorkflow(id: string, mutate: (workflow: WorkflowRun) => void): WorkflowRun {
    const index = this.state.workflows.findIndex((workflow) => workflow.id === id);
    if (index === -1) throw new Error("Workflow not found");
    // Copy-on-write: validation failure không làm thay đổi state đang lưu.
    const next = structuredClone(this.state.workflows[index]);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    const before = this.state.workflows[index].status;
    if (next.status !== before) {
      const notices: Partial<Record<WorkflowRun["status"],
        { kind: NotificationEntry["kind"]; title: string }>> = {
        waiting_business_approval: { kind: "business_approval", title: "Workflow chờ duyệt" },
        waiting_manual_verification: { kind: "manual_verification", title: "Cần xác minh thủ công" },
        blocked: { kind: "workflow_blocked", title: "Workflow bị chặn" },
        failed: { kind: "workflow_failed", title: "Workflow thất bại" },
        interrupted: { kind: "workflow_interrupted", title: "Workflow gián đoạn" }
      };
      const notice = notices[next.status];
      if (notice) this.notify("workflow", id, notice.kind, notice.title,
        next.title + (next.blocker ? ": " + next.blocker : next.error ? ": " + next.error : "") +
          (next.failureHint?.code === "dirty_source"
            ? " · Kiểm tra Git status tại " + next.failureHint.path +
              "; commit hoặc stash -u các thay đổi, rồi tạo Workflow mới. Không tự clean." : ""));
    }
    this.state.workflows[index] = next;
    this.save(); this.emit("change");
    return next;
  }

  addApproval(input: Omit<RuntimeApproval, "id" | "status" | "createdAt">) {
    const approval: RuntimeApproval = {
      ...input, id: randomUUID(), status: "pending", createdAt: new Date().toISOString()
    };
    this.state.approvals.push(approval);
    this.save(); this.emit("change");
    return approval;
  }
  resolveApproval(id: string, decision: "accepted" | "declined") {
    const approval = this.state.approvals.find((item) => item.id === id);
    if (!approval || approval.status !== "pending") throw new Error("Approval unavailable");
    approval.status = decision;
    this.save(); this.emit("change");
    return approval;
  }
  expireApprovals(taskId: string) {
    let changed = false;
    for (const approval of this.state.approvals) {
      if (approval.taskId === taskId && approval.status === "pending") {
        approval.status = "expired";
        changed = true;
      }
    }
    if (changed) { this.save(); this.emit("change"); }
  }
}
