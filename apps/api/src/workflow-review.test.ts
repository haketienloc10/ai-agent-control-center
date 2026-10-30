import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, WorkflowRun, WorkspaceConfig } from "@aacc/contracts";
import { TaskStore } from "./store.js";
import { WorkflowEngine } from "./workflow-engine.js";
import type { AgentTaskExecutor } from "./session-manager.js";

async function until(store: TaskStore, id: string, statuses: string[]): Promise<WorkflowRun> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      store.off("change", check);
      reject(new Error("Timeout waiting workflow"));
    }, 10000);
    const check = () => {
      const current = store.getWorkflow(id);
      if (current && statuses.includes(current.status)) {
        clearTimeout(timeout);
        store.off("change", check);
        resolve(current);
      }
    };
    store.on("change", check);
    check();
  });
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aacc-review-"));
  const api = join(dir, "api");
  const web = join(dir, "web");
  mkdirSync(api);
  mkdirSync(web);
  const config: WorkspaceConfig = {
    lead: { cwd: dir, instructions: "Lead" },
    modules: [
      { id: "api", label: "API", path: api },
      { id: "web", label: "Web", path: web }
    ]
  };
  const store = new TaskStore(join(dir, "data"));
  let invalidWebReviewRemaining = 0;
  const peerRuns: string[] = [];
  const reviewPrompts: string[] = [];
  const executor: AgentTaskExecutor = {
    async runAndWait(taskId: string) {
      const task = store.get(taskId)!;
      store.update(taskId, {}, "starting");
      store.update(taskId, {}, "running");
      let output: string;
      if (task.title.startsWith("Lead: lập kế hoạch")) {
        output = JSON.stringify({
          summary: "API then Web",
          tasks: [
            { id: "api1", title: "API", moduleId: "api", instructions: "Build API", dependsOn: [] },
            { id: "web1", title: "Web", moduleId: "web", instructions: "Build UI", dependsOn: ["api1"] }
          ]
        });
      } else if (task.role === "peer") {
        peerRuns.push(task.moduleId!);
        output = JSON.stringify({ summary: "Made changes", changedFiles: [],
          tests: [{ status: "not_run" }], risks: [] });
      } else {
        reviewPrompts.push(task.prompt);
        const batchMatch = /BATCH_TASK_IDS \(phải giữ nguyên từng ID\): (\[[^\n]*\])/.exec(task.prompt);
        assert.ok(batchMatch, "Review prompt must contain exact batch IDs");
        const ids = JSON.parse(batchMatch[1]) as string[];
        if (ids.includes("web1") && peerRuns.filter((m) => m === "web").length === 2 &&
            invalidWebReviewRemaining > 0) {
          invalidWebReviewRemaining--;
          // Có hai quyết định, trong khi batch đang review chỉ có web1.
          output = JSON.stringify({ summary: "Accidentally reviewed all peers", reviews: [
            { taskId: "api1", decision: "accept", feedback: "Already accepted" },
            { taskId: "web1", decision: "accept", feedback: "Web ok" }
          ] });
        } else {
          output = JSON.stringify({ summary: "Reviewed", reviews: ids.map((taskId) => ({
            taskId,
            decision: taskId === "web1" && peerRuns.filter((m) => m === "web").length === 1
              ? "rework" : "accept",
            feedback: "Check API integration"
          })) });
        }
      }
      store.update(taskId, { output }, "completed");
      return output;
    }
  };
  return {
    store, dir, peerRuns, reviewPrompts,
    engine: new WorkflowEngine(config, store, executor),
    setInvalidWebReviewRemaining(value: number) { invalidWebReviewRemaining = value; }
  };
}

test("review schema retry chỉ chạy lại Lead, giữ API accepted và không chạy lại Peer", async () => {
  const ctx = await setup();
  try {
    ctx.setInvalidWebReviewRemaining(1);
    const workflow = ctx.engine.create({ title: "Board", request: "Build Mini Task Board" });
    const completed = await until(ctx.store, workflow.id, ["waiting_business_approval", "failed"]);
    assert.equal(completed.status, "waiting_business_approval", completed.error);
    assert.deepEqual(ctx.peerRuns, ["api", "web", "web"]);
    assert.equal(completed.peers[0].status, "accepted");
    assert.equal(completed.peers[1].status, "accepted");
    assert.equal(completed.peers[1].attempts.length, 2);
    assert.equal(completed.reviewCount, 3);
    assert.equal(ctx.reviewPrompts.length, 4); // api, web, web invalid, web corrected
    assert.match(ctx.reviewPrompts.at(-1)!, /KẾT QUẢ TRƯỚC BỊ TỪ CHỐI/);
    assert.ok(ctx.store.events().some((e) => e.kind === "workflow/review_validation_failed"));
    assert.equal(ctx.engine.decide(workflow.id, "approve").status, "completed");
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("workflow failed vì LeadReview thiếu quyết định có thể resume review, không rerun Peer", async () => {
  const ctx = await setup();
  try {
    ctx.setInvalidWebReviewRemaining(3);
    const workflow = ctx.engine.create({ title: "Board", request: "Build Mini Task Board" });
    const failed = await until(ctx.store, workflow.id, ["failed", "waiting_business_approval"]);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /LeadReview sai schema sau 3 lần/);
    assert.equal(failed.peers[0].status, "accepted");
    assert.equal(failed.peers[1].status, "review_pending");
    assert.deepEqual(ctx.peerRuns, ["api", "web", "web"]);
    const retriesBefore = ctx.reviewPrompts.length;
    const resumed = ctx.engine.retryReview(workflow.id);
    assert.equal(resumed.status, "reviewing");
    assert.throws(() => ctx.engine.retryReview(workflow.id), /đang chạy|Chỉ retry/);
    const successful = await until(ctx.store, workflow.id, ["waiting_business_approval", "failed"]);
    assert.equal(successful.status, "waiting_business_approval", successful.error);
    assert.deepEqual(ctx.peerRuns, ["api", "web", "web"]);
    assert.equal(ctx.reviewPrompts.length, retriesBefore + 1);
    assert.equal(successful.reviewCount, 3);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("không thể dùng retryReview để bỏ qua lỗi thực thi hoặc workflow không có PeerResult", async () => {
  const ctx = await setup();
  try {
    ctx.store.addWorkflow({
      id: "bad", title: "Bad", request: "x", status: "failed", error: "Codex RPC timeout",
      plan: { summary: "Plan", tasks: [] },
      peers: [{ id: "web1", moduleId: "web", title: "Web", instructions: "x", dependsOn: [],
        status: "review_pending", attempts: [{ taskId: "t", iteration: 1 }],
        result: { summary: "x", tests: [], changedFiles: [], risks: [] } }],
      leadTaskIds: [], reviewCount: 0, maxReworks: 2,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    assert.throws(() => ctx.engine.retryReview("bad"), /nguyên nhân khác/);
    assert.throws(() => ctx.engine.retryReview("missing"), /not found/);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});
