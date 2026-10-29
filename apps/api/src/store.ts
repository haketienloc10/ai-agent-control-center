import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityEvent, RuntimeApproval, Task, TaskStatus, WorkflowRun } from "@aacc/contracts";
import { assertTransition } from "./domain.js";

interface Persisted {
  tasks: Task[];
  events: ActivityEvent[];
  approvals: RuntimeApproval[];
  workflows: WorkflowRun[];
}

export class TaskStore extends EventEmitter {
  private readonly file: string;
  private state: Persisted;

  constructor(dataDir: string) {
    super();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, "state.json");
    const raw = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted>
      : {};
    this.state = {
      tasks: raw.tasks ?? [], events: raw.events ?? [],
      approvals: raw.approvals ?? [], workflows: raw.workflows ?? []
    };
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
      if (["planning", "executing", "reviewing"].includes(workflow.status)) {
        workflow.status = "interrupted";
        workflow.error = "Backend restarted; do not auto-dispatch without reconciliation";
        workflow.updatedAt = new Date().toISOString();
      }
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
    this.save(); this.emit("change");
    return task;
  }
  event(taskId: string, kind: string, data: unknown) {
    const event: ActivityEvent = { id: randomUUID(), taskId, kind, data, createdAt: new Date().toISOString() };
    this.state.events.push(event);
    this.state.events = this.state.events.slice(-1000);
    this.save(); this.emit("change");
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
