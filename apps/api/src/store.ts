import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActivityEntry, ActivityEvent, RuntimeApproval, Task, TaskStatus, WorkflowRun } from "@aacc/contracts";
import { projectActivity } from "./activity.js";
import { assertTransition } from "./domain.js";

interface Persisted {
  tasks: Task[];
  events: ActivityEvent[];
  approvals: RuntimeApproval[];
  workflows: WorkflowRun[];
  activities: ActivityEntry[];
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
    const saved = this.db.prepare("SELECT json FROM snapshots WHERE id=1").get() as { json: string } | undefined;
    const raw = saved ? JSON.parse(saved.json) as Partial<Persisted> : existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted> : {};
    if (!saved && raw.events?.length) this.pendingJournal = [...raw.events];
    this.state = {
      tasks: raw.tasks ?? [], events: raw.events ?? [],
      approvals: raw.approvals ?? [], workflows: raw.workflows ?? [],
      activities: raw.activities ?? []
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
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    if (status) projectActivity(this.state.activities, {
      id: randomUUID(), taskId: id, kind: "task/status", data: { status, error: patch.error },
      createdAt: task.updatedAt
    });
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
