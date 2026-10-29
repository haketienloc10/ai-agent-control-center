import { randomUUID } from "node:crypto";
import type { AgentRole, Task, TaskStatus, WorkspaceConfig } from "@aacc/contracts";

export function createTask(input: unknown, config: WorkspaceConfig): Task {
  if (!input || typeof input !== "object") throw new Error("Body không hợp lệ");
  const value = input as Record<string, unknown>;
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 200) {
    throw new Error("title phải có 1-200 ký tự");
  }
  if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 20000) {
    throw new Error("prompt phải có 1-20000 ký tự");
  }
  if (value.role !== "lead" && value.role !== "peer") throw new Error("role phải là lead hoặc peer");
  const role: AgentRole = value.role;
  if (role === "peer" && (typeof value.moduleId !== "string" ||
       !config.modules.some((module) => module.id === value.moduleId))) {
    throw new Error("Peer phải chọn module đã đăng ký");
  }
  if (role === "lead" && value.moduleId !== undefined) throw new Error("Lead không nhận moduleId");
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: value.title.trim(),
    prompt: value.prompt.trim(),
    role,
    ...(role === "peer" ? { moduleId: value.moduleId as string } : {}),
    status: "queued",
    createdAt: now,
    updatedAt: now
  };
}

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["starting"],
  starting: ["running", "failed", "interrupted"],
  running: ["waiting_runtime_approval", "completed", "failed", "interrupted"],
  waiting_runtime_approval: ["running", "failed", "interrupted"],
  completed: [],
  failed: [],
  interrupted: []
};

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!transitions[from].includes(to)) throw new Error("Invalid task status transition: " + from + " -> " + to);
}

export function cwdForTask(task: Task, config: WorkspaceConfig): string {
  if (task.role === "lead") return config.lead.cwd;
  const module = config.modules.find((item) => item.id === task.moduleId);
  if (!module) throw new Error("Module chưa được đăng ký: " + task.moduleId);
  return module.path;
}
