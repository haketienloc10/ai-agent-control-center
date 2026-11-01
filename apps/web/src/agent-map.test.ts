import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModuleConfig, Task } from "@aacc/contracts";
import { agentMapNodes } from "./AgentMap.js";

const now = "2026-11-01T10:00:00.000Z";
function task(id: string, role: Task["role"], status: Task["status"],
  workflowId: string, moduleId?: string): Task {
  return { id, title: "Task " + id, role, prompt: "work", status,
    workflowId, ...(moduleId ? { moduleId } : {}), createdAt: now, updatedAt: now };
}
test("Agent Map shows current workflow roles, prefers active session, no synthetic activity", () => {
  const modules: ModuleConfig[] = [
    { id: "api", label: "API", path: "/repo/api" },
    { id: "web", label: "Web", path: "/repo/web" }
  ];
  const tasks = [
    task("web-running", "peer", "running", "wf-a", "web"),
    task("lead-done", "lead", "completed", "wf-a"),
    task("reviewer-done", "reviewer", "completed", "wf-b"),
    task("web-old", "peer", "completed", "wf-a", "web"),
    task("api-running-other", "peer", "running", "wf-b", "api")
  ];
  const nodes = agentMapNodes(modules, tasks, "wf-a");
  assert.equal(nodes.length, 4);
  assert.equal(nodes.find(n => n.role === "lead")?.task?.id, "lead-done");
  assert.equal(nodes.find(n => n.moduleId === "web")?.status, "running");
  assert.equal(nodes.find(n => n.moduleId === "web")?.count, 1);
  assert.equal(nodes.find(n => n.moduleId === "api")?.status, "idle");
  assert.equal(nodes.find(n => n.role === "reviewer")?.status, "idle");
});
test("Agent Map uses latest completed task when no active task, also handles no modules", () => {
  const nodes = agentMapNodes([], [task("review-1", "reviewer", "completed", "wf")], "wf");
  assert.deepEqual(nodes.map(n => n.role), ["lead", "reviewer"]);
  assert.equal(nodes[1].task?.id, "review-1");
  assert.equal(nodes[0].status, "idle");
});
