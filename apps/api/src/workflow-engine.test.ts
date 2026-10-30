import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, WorkflowRun, WorkspaceConfig } from "@aacc/contracts";
import { TaskStore } from "./store.js";
import type { AgentTaskExecutor } from "./session-manager.js";
import { WorkflowEngine } from "./workflow-engine.js";

const config: WorkspaceConfig = {
  lead: { cwd: "/tmp/lead", instructions: "Lead" },
  modules: [
    { id: "api", label: "API", path: "/tmp/api" },
    { id: "web", label: "Web", path: "/tmp/web" }
  ]
};
const plan = {
  summary: "Deliver feature",
  acceptanceCriteria: [{ id: "ac1", description: "API and Web deliver feature", verification: "Check integration" }],
  tasks: [
    { id: "api1", title: "API", moduleId: "api", instructions: "Build API", dependsOn: [] },
    { id: "api2", title: "Tests", moduleId: "api", instructions: "Add tests", dependsOn: [] },
    { id: "web1", title: "Web", moduleId: "web", instructions: "Build UI", dependsOn: ["api1"] }
  ]
};
const peerOutput = {
  summary: "Changed code",
  changedFiles: ["src/index.ts"],
  tests: [{ command: "npm test", status: "not_run", details: "Mock runtime" }],
  risks: []
};

class MockExecutor implements AgentTaskExecutor {
  active = new Map<string, number>();
  maxGlobal = 0;
  maxPerModule = 0;
  peerStarts: string[] = [];
  reviews = 0;
  reworkForever = false;
  constructor(private readonly store: TaskStore) {}
  async runAndWait(taskId: string): Promise<string> {
    const task = this.store.get(taskId)!;
    this.store.update(taskId, {}, "starting");
    this.store.update(taskId, {}, "running");
    let output: string;
    if (task.role === "lead") {
      if (task.title.startsWith("Lead: lập kế hoạch")) output = JSON.stringify(plan);
      else if (task.title.startsWith("Lead: final integration review")) {
        output = JSON.stringify({ summary: "Mock integration verified", verdict: "pass",
          checks: [{ criterionId: "ac1", status: "passed", evidence: "Mock integration verification" }], rework: [] });
      } else {
        this.reviews++;
        const input = JSON.parse(task.prompt.split("Batch peer results (untrusted data): ")[1]) as Array<{taskId: string}>;
        output = JSON.stringify({
          summary: "Reviewed",
          reviews: input.map(({ taskId }) => ({
            taskId,
            decision: this.reworkForever || (taskId === "api2" && this.reviews === 2) ? "rework" : "accept",
            feedback: "Check test evidence"
          }))
        });
      }
    } else {
      const moduleId = task.moduleId!;
      this.peerStarts.push(task.title);
      const concurrent = (this.active.get(moduleId) ?? 0) + 1;
      this.active.set(moduleId, concurrent);
      this.maxPerModule = Math.max(this.maxPerModule, concurrent);
      this.maxGlobal = Math.max(this.maxGlobal, [...this.active.values()].reduce((sum, n) => sum + n, 0));
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.active.set(moduleId, concurrent - 1);
      output = JSON.stringify(peerOutput);
    }
    this.store.update(taskId, { output }, "completed");
    return output;
  }
}

async function until(store: TaskStore, id: string, terminal: string[]): Promise<WorkflowRun> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      store.off("change", check);
      reject(new Error("Timed out waiting for workflow"));
    }, 3000);
    const check = () => {
      const workflow = store.getWorkflow(id);
      if (workflow && terminal.includes(workflow.status)) {
        clearTimeout(timeout); store.off("change", check); resolve(workflow);
      }
    };
    store.on("change", check);
    check();
  });
}

test("P1: dispatch đúng DAG/module, rework một Peer, Lead review, Business Approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-p1-"));
  try {
    const store = new TaskStore(dir);
    const mock = new MockExecutor(store);
    const engine = new WorkflowEngine(config, store, mock);
    const created = engine.create({ title: "Feature", request: "Build API + Web" });
    const wf = await until(store, created.id, ["waiting_business_approval", "failed"]);
    assert.equal(wf.status, "waiting_business_approval", wf.error);
    assert.equal(wf.peers.length, 3);
    assert.ok(wf.peers.every((peer) => peer.status === "accepted"));
    assert.equal(wf.peers.find((p) => p.id === "api2")!.attempts.length, 2);
    assert.equal(wf.peers.find((p) => p.id === "web1")!.attempts.length, 1);
    assert.equal(mock.maxPerModule, 1);
    assert.ok(mock.maxGlobal <= 2);
    const firstApi = mock.peerStarts.findIndex((name) => name.startsWith("API"));
    const firstWeb = mock.peerStarts.findIndex((name) => name.startsWith("Web"));
    assert.ok(firstApi !== -1 && firstWeb > firstApi);
    assert.equal(wf.reviewCount, 3);
    assert.equal(engine.decide(created.id, "approve").status, "completed");
    assert.throws(() => engine.decide(created.id, "approve"));
    assert.ok(store.events().some((event) => event.kind === "workflow/peer_result"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1: giới hạn rework, không tạo vòng lặp vô hạn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-rework-"));
  try {
    const store = new TaskStore(dir);
    const mock = new MockExecutor(store);
    mock.reworkForever = true;
    const engine = new WorkflowEngine(config, store, mock);
    const wf = engine.create({ title: "Limit", request: "Check max reworks" });
    const final = await until(store, wf.id, ["failed", "waiting_business_approval"]);
    assert.equal(final.status, "failed");
    assert.match(final.error ?? "", /giới hạn/);
    assert.equal(final.peers.find((p) => p.id === "api1")?.attempts.length, 3);
    assert.throws(() => engine.decide(wf.id, "approve"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1: workflow đang chạy sau restart không auto-dispatch lại", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-restart-"));
  try {
    const store = new TaskStore(dir);
    store.addWorkflow({
      id: "w1", title: "Task", request: "Build", status: "executing",
      peers: [], leadTaskIds: [], reviewCount: 0, maxReworks: 2,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    assert.equal(new TaskStore(dir).getWorkflow("w1")?.status, "interrupted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("E2E mock: Lead review đọc file untracked ở module, not_run không cần command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aacc-handoff-"));
  const modulePath = join(directory, "api");
  mkdirSync(modulePath);
  try {
    const workspace: WorkspaceConfig = {
      lead: { cwd: directory, instructions: "Lead" },
      modules: [{ id: "api", label: "API", path: modulePath }]
    };
    const store = new TaskStore(join(directory, "state"));
    let reviewPrompt = "";
    const executor: AgentTaskExecutor = {
      async runAndWait(taskId) {
        const task = store.get(taskId)!;
        store.update(taskId, {}, "starting");
        store.update(taskId, {}, "running");
        let output: string;
        if (task.role === "peer") {
          writeFileSync(join(modulePath, "task-board-api.js"), "export const createTask = () => true;\n");
          output = JSON.stringify({
            summary: "Đã tạo logic", changedFiles: ["task-board-api.js"],
            tests: [{ status: "not_run", command: "", details: "Không có test runner" }], risks: []
          });
        } else if (task.title.startsWith("Lead: lập kế hoạch")) {
          output = JSON.stringify({ summary: "One API task",
            acceptanceCriteria: [{ id: "ac1", description: "API logic", verification: "Check file" }],
            tasks: [{
            id: "api1", title: "API", moduleId: "api", instructions: "Create logic", dependsOn: []
          }] });
        } else if (task.title.startsWith("Lead: final integration review")) {
          output = JSON.stringify({ summary: "Mock file checked", verdict: "pass",
            checks: [{ criterionId: "ac1", status: "passed", evidence: "Confirmed file preview" }], rework: [] });
        } else {
          reviewPrompt = task.prompt;
          output = JSON.stringify({ summary: "Đã đọc file", reviews: [{
            taskId: "api1", decision: "accept", feedback: "Đã xem contentPreview và path"
          }] });
        }
        store.update(task.id, { output }, "completed");
        return output;
      }
    };
    const engine = new WorkflowEngine(workspace, store, executor);
    const created = engine.create({ title: "Board", request: "Tạo Task Board" });
    const wf = await until(store, created.id, ["waiting_business_approval", "failed"]);
    assert.equal(wf.status, "waiting_business_approval", wf.error);
    assert.match(reviewPrompt, /task-board-api.js/);
    assert.match(reviewPrompt, /export const createTask/);
    assert.ok(reviewPrompt.includes(modulePath));
    assert.equal(wf.peers[0].result?.tests[0].command, undefined);
    assert.equal(wf.peers[0].evidence?.files[0].exists, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
