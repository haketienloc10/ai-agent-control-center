import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun, WorkspaceConfig } from "@aacc/contracts";
import { createTask } from "./domain.js";
import { TaskStore } from "./store.js";
import { runtimeMetrics } from "./metrics.js";

const config: WorkspaceConfig = { lead: { cwd: "/tmp", instructions: "Lead" }, modules: [] };
const workflow = (id: string): WorkflowRun => ({
  id, title: "Task Board", request: "Build UI", status: "planning",
  peers: [], leadTaskIds: [], reviewCount: 0, maxReworks: 2,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
});

test("P3 durable notifications persist across SQLite restart, acknowledgement idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-p3-alerts-"));
  let store: TaskStore | undefined;
  try {
    store = new TaskStore(dir);
    const task = store.add(createTask({ role: "lead", title: "Failed job", prompt: "Run" }, config));
    store.update(task.id, {}, "starting");
    store.update(task.id, {}, "running");
    store.update(task.id, { error: "Tool unavailable" }, "failed");
    assert.ok(store.get(task.id)?.startedAt);
    assert.ok(store.get(task.id)?.finishedAt);
    assert.equal(store.notifications().length, 1);
    const wf = store.addWorkflow(workflow("wf1"));
    store.mutateWorkflow(wf.id, w => { w.status = "waiting_business_approval"; });
    store.mutateWorkflow(wf.id, w => { w.error = "No change"; });
    assert.equal(store.notifications().length, 2, "No duplicate on same workflow status");
    const notice = store.notifications()[0];
    assert.equal(notice.kind, "business_approval");
    store.acknowledge(notice.id);
    store.acknowledge(notice.id);
    assert.equal(store.unreadNotifications(), 1);
    store.close(); store = undefined;
    const restarted = new TaskStore(dir); store = restarted;
    assert.equal(restarted.notifications().length, 2);
    assert.equal(restarted.unreadNotifications(), 1);
    const page = restarted.sessions({ limit: 1 });
    assert.equal(page.items[0].id, task.id);
    assert.ok((page.items[0].durationMs ?? -1) >= 0);
    assert.equal(restarted.notifications()[0].readAt !== undefined, true);
    assert.throws(() => restarted.acknowledge("does-not-exist"), /not found/);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("P3 session history keyset pagination, workflow/role/status filters and cursor rejection", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-p3-sessions-"));
  const store = new TaskStore(dir);
  try {
    const first = store.add(createTask({ role: "lead", title: "A", prompt: "a" }, config));
    const second = store.add(createTask({ role: "lead", title: "B", prompt: "b" }, config));
    const third = store.add(createTask({ role: "reviewer", title: "C", prompt: "c" }, config));
    store.update(second.id, {}, "starting");
    store.update(second.id, {}, "running");
    store.update(second.id, {}, "completed");
    const a = store.sessions({ limit: 2 });
    assert.deepEqual(a.items.map(v => v.id), [third.id, second.id]);
    assert.equal(a.nextCursor, second.id);
    const b = store.sessions({ limit: 2, cursor: a.nextCursor });
    assert.deepEqual(b.items.map(v => v.id), [first.id]);
    assert.equal(b.nextCursor, undefined);
    assert.deepEqual(store.sessions({ role: "reviewer" }).items.map(v => v.id), [third.id]);
    assert.deepEqual(store.sessions({ status: "completed" }).items.map(v => v.id), [second.id]);
    assert.deepEqual(store.sessions({ workflowId: "nonexistent" }).items, []);
    assert.throws(() => store.sessions({ cursor: "missing" }), /cursor/);
    assert.throws(() => store.sessions({ limit: 999 }), /limit/);
    assert.throws(() => store.sessions({ role: "administrator" }), /role/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("P3 journal SQL filters and cursor page newest-first, escape special LIKE chars", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-p3-journal-"));
  const store = new TaskStore(dir);
  try {
    store.event("workflow:w1", "workflow/planning", { summary: "Create Task Board" });
    store.event("taskA", "task/status", { status: "running" });
    store.event("workflow:w1", "workflow/review", { summary: "Peer passed" });
    store.event("taskB", "runtime/error", { message: "Timeout during build" });
    assert.deepEqual(store.journalPage({ limit: 2 }).items.map(x => x.kind),
      ["runtime/error", "workflow/review"]);
    const first = store.journalPage({ limit: 2 });
    const older = store.journalPage({ limit: 2, before: first.nextCursor });
    assert.deepEqual(older.items.map(x => x.kind), ["task/status", "workflow/planning"]);
    assert.deepEqual(store.journalPage({ kind: "workflow/" }).items.map(x => x.kind),
      ["workflow/review", "workflow/planning"]);
    assert.equal(store.journalPage({ taskId: "taskB", search: "timeout" }).items.length, 1);
    assert.equal(store.journalPage({ kind: "workflow_%", limit: 20 }).items.length, 0,
      "Percent and underscore must not behave as SQL wildcard");
    assert.throws(() => store.journalPage({ before: -1 }), /pagination/);
    assert.throws(() => store.journalPage({ search: "x".repeat(121) }), /filter/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("P3 process metrics are explicitly backend-level, resource values and queue counts grounded", () => {
  const tasks = [
    { status: "queued" }, { status: "running" }, { status: "completed" },
    { status: "failed" }, { status: "interrupted" }
  ] as import("@aacc/contracts").Task[];
  const workflows = [
    { status: "executing" }, { status: "waiting_business_approval" }, { status: "blocked" }
  ] as WorkflowRun[];
  const result = runtimeMetrics(tasks, workflows, 3, {
    memory: { rss: 41943040, heapUsed: 10485760 },
    cpu: { user: 1500000, system: 500000 }, uptime: 366
  });
  assert.equal(result.backend.rssBytes, 41943040);
  assert.equal(result.backend.cpuUserSeconds + result.backend.cpuSystemSeconds, 2);
  assert.equal(result.tasks.active, 1);
  assert.equal(result.tasks.queued, 1);
  assert.equal(result.workflows.active, 1);
  assert.equal(result.workflows.waitingHuman, 1);
  assert.equal(result.alerts.unread, 3);
});

test("P3 restart creates exactly one interruption notification per active task/workflow", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-p3-restart-alert-"));
  let store: TaskStore | undefined;
  try {
    store = new TaskStore(dir);
    const t = store.add(createTask({ role: "lead", title: "Running", prompt: "work" }, config));
    store.update(t.id, {}, "starting");
    store.update(t.id, {}, "running");
    store.addWorkflow({ ...workflow("wf-restart"), status: "executing" });
    store.close(); store = new TaskStore(dir);
    assert.equal(store.get(t.id)?.status, "interrupted");
    assert.equal(store.getWorkflow("wf-restart")?.status, "interrupted");
    assert.deepEqual(store.notifications().map(n => n.kind).sort(),
      ["task_interrupted", "workflow_interrupted"]);
    store.close(); store = new TaskStore(dir);
    assert.equal(store.notifications().length, 2, "No duplicate after second restart");
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
