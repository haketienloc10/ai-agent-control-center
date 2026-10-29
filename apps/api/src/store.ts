import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityEvent, RuntimeApproval, Task, TaskStatus } from "@aacc/contracts";
import { assertTransition } from "./domain.js";

interface Persisted {
  tasks: Task[];
  events: ActivityEvent[];
  approvals: RuntimeApproval[];
}

export class TaskStore extends EventEmitter {
  private readonly file: string;
  private state: Persisted;

  constructor(dataDir: string) {
    super();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, "state.json");
    this.state = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8")) as Persisted
      : { tasks: [], events: [], approvals: [] };
    // Sau restart không thể giả định app-server cũ còn chạy. Cần reconcile trước khi resume.
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
    this.save();
  }

  private save() {
    const temp = this.file + ".tmp";
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  list() { return [...this.state.tasks].reverse(); }
  events() { return this.state.events.slice(-150); }
  approvals() { return [...this.state.approvals].reverse(); }
  get(id: string) { return this.state.tasks.find((task) => task.id === id); }

  add(task: Task) {
    this.state.tasks.push(task);
    this.save();
    this.emit("change");
    return task;
  }

  update(id: string, patch: Partial<Task>, status?: TaskStatus) {
    const task = this.get(id);
    if (!task) throw new Error("Task not found");
    if (status) {
      assertTransition(task.status, status);
      task.status = status;
    }
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.save();
    this.emit("change");
    return task;
  }

  event(taskId: string, kind: string, data: unknown) {
    const event: ActivityEvent = { id: randomUUID(), taskId, kind, data, createdAt: new Date().toISOString() };
    this.state.events.push(event);
    this.state.events = this.state.events.slice(-1000);
    this.save();
    this.emit("change");
    return event;
  }

  addApproval(input: Omit<RuntimeApproval, "id" | "status" | "createdAt">) {
    const approval: RuntimeApproval = {
      ...input, id: randomUUID(), status: "pending", createdAt: new Date().toISOString()
    };
    this.state.approvals.push(approval);
    this.save();
    this.emit("change");
    return approval;
  }

  resolveApproval(id: string, decision: "accepted" | "declined") {
    const approval = this.state.approvals.find((item) => item.id === id);
    if (!approval || approval.status !== "pending") throw new Error("Approval unavailable");
    approval.status = decision;
    this.save();
    this.emit("change");
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
    if (changed) {
      this.save();
      this.emit("change");
    }
  }
}
