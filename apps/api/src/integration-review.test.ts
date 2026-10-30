import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun, WorkspaceConfig } from "@aacc/contracts";
import { WorkflowEngine } from "./workflow-engine.js";
import { TaskStore } from "./store.js";
import type { AgentTaskExecutor } from "./session-manager.js";

async function until(store: TaskStore, workflowId: string, statuses: string[]): Promise<WorkflowRun> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { store.off("change", check); reject(new Error("Timed out")); }, 7000);
    function check() {
      const workflow = store.getWorkflow(workflowId);
      if (workflow && statuses.includes(workflow.status)) {
        clearTimeout(timer); store.off("change", check); resolve(workflow);
      }
    }
    store.on("change", check);
    check();
  });
}

function setup(mode: "integration-rework" | "manual-verification" | "web-rework" | "rework-forever",
  invalidPlanOnce = false) {
  const dir = mkdtempSync(join(tmpdir(), "aacc-integration-"));
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
  const store = new TaskStore(join(dir, "state"));
  const peerRuns: string[] = [];
  const integrationPrompts: string[] = [];
  let integrations = 0;
  let planCalls = 0;
  const executor: AgentTaskExecutor = {
    async runAndWait(taskId: string): Promise<string> {
      const task = store.get(taskId)!;
      store.update(taskId, {}, "starting");
      store.update(taskId, {}, "running");
      let output: unknown;
      if (task.title.startsWith("Lead: lập kế hoạch")) {
        planCalls++;
        output = {
          summary: "Implement task board",
          acceptanceCriteria: [
            { id: "ac-api", description: "API handles tasks", verification: "Inspect API contract" },
            { id: "ac-ui", description: "Web integrates API", verification: "Run end-to-end UI operations" }
          ],
          tasks: [
            { id: "api1", moduleId: "api", title: "API", instructions: "Implement API", dependsOn: [] },
            { id: "web1", moduleId: "web", title: "UI", instructions: "Implement UI", dependsOn: ["api1"] }
          ]
        };
        if (invalidPlanOnce && planCalls === 1) {
          // Simulate a Lead response that omitted required acceptance criteria.
          delete (output as Record<string, unknown>).acceptanceCriteria;
        }
      } else if (task.role === "peer") {
        peerRuns.push(task.moduleId!);
        output = { summary: "Worked on " + task.moduleId, changedFiles: [], tests: [
          { status: "not_run", details: "Mock executor" }
        ], risks: [] };
      } else if (task.title.startsWith("Lead: final integration review")) {
        integrations++;
        integrationPrompts.push(task.prompt);
        const base = [
          { criterionId: "ac-api", status: "passed", evidence: "API code reviewed" },
          { criterionId: "ac-ui", status: "passed", evidence: "UI integration checked" }
        ];
        if (mode === "manual-verification") {
          output = {
            summary: "Needs a human browser test", verdict: "manual_verification",
            checks: [
              base[0],
              { criterionId: "ac-ui", status: "unverified", evidence: "Browser interaction not run" }
            ], rework: []
          };
        } else if (integrations === 1 || mode === "rework-forever") {
          output = {
            summary: "Modules are not integrated", verdict: "rework",
            checks: [
              { criterionId: "ac-api", status: mode === "integration-rework" ? "failed" : "passed",
                evidence: "Mismatch in shared API contract" },
              { criterionId: "ac-ui", status: "failed", evidence: "UI cannot call API" }
            ],
            rework: [{
              taskId: mode === "integration-rework" ? "api1" : "web1",
              feedback: "Connect the UI and API correctly"
            }]
          };
        } else {
          output = { summary: "Cross-module integration verified", verdict: "pass",
            checks: base, rework: [] };
        }
      } else {
        // Peer-level Lead review has no final integration authority.
        const ids = JSON.parse(/BATCH_TASK_IDS \(phải giữ nguyên từng ID\): (\[[^\n]*\])/.exec(task.prompt)![1]) as string[];
        output = { summary: "Peer accepted", reviews: ids.map((taskId) => ({
          taskId, decision: "accept", feedback: "Module implementation accepted"
        })) };
      }
      const text = JSON.stringify(output);
      store.update(taskId, { output: text }, "completed");
      return text;
    }
  };
  return { dir, store, peerRuns, integrationPrompts, get planCalls() { return planCalls; },
    engine: new WorkflowEngine(config, store, executor) };
}

test("Final review phát hiện API mismatch, rework API và downstream Web, sau đó mới Business Approval", async () => {
  const ctx = setup("integration-rework");
  try {
    const workflow = ctx.engine.create({ title: "Board", request: "Make Mini Task Board" });
    const result = await until(ctx.store, workflow.id, ["waiting_business_approval", "failed"]);
    assert.equal(result.status, "waiting_business_approval", result.error);
    assert.equal(result.integrationReviewCount, 2);
    assert.equal(result.finalReview?.verdict, "pass");
    assert.deepEqual(ctx.peerRuns, ["api", "web", "api", "web"]);
    assert.deepEqual(result.peers.map((p) => p.attempts.length), [2, 2]);
    assert.match(ctx.integrationPrompts[0], /REQUIRED_CRITERION_IDS/);
    assert.match(ctx.integrationPrompts[0], /modulePath/);
    assert.ok(ctx.store.events().some((evt) => evt.kind === "workflow/integration_review"));
    assert.equal(ctx.engine.decide(workflow.id, "approve").status, "completed");
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Final review có thể yêu cầu rework Web mà không chạy lại API", async () => {
  const ctx = setup("web-rework");
  try {
    const workflow = ctx.engine.create({ title: "Board", request: "Make Mini Task Board" });
    const result = await until(ctx.store, workflow.id, ["waiting_business_approval", "failed"]);
    assert.equal(result.status, "waiting_business_approval", result.error);
    assert.deepEqual(ctx.peerRuns, ["api", "web", "web"]);
    assert.equal(result.peers[0].attempts.length, 1);
    assert.equal(result.peers[1].attempts.length, 2);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Unverified criterion yêu cầu manual confirmation trước Business Approval", async () => {
  const ctx = setup("manual-verification");
  try {
    const workflow = ctx.engine.create({ title: "Board", request: "Make Mini Task Board" });
    const result = await until(ctx.store, workflow.id, ["waiting_manual_verification", "failed"]);
    assert.equal(result.status, "waiting_manual_verification", result.error);
    assert.equal(result.finalReview?.checks[1].status, "unverified");
    assert.throws(() => ctx.engine.decide(workflow.id, "approve"), /Business Approval/);
    assert.throws(() => ctx.engine.confirmManualVerification(workflow.id, []), /xác nhận/);
    assert.throws(() => ctx.engine.confirmManualVerification(workflow.id, ["ac-api"]), /xác nhận/);
    assert.throws(() => ctx.engine.confirmManualVerification(workflow.id, ["ac-ui", "ac-ui"]), /xác nhận/);
    assert.equal(ctx.engine.confirmManualVerification(workflow.id, ["ac-ui"]).status, "waiting_business_approval");
    assert.deepEqual(ctx.store.getWorkflow(workflow.id)?.manualVerifiedCriterionIds, ["ac-ui"]);
    assert.equal(ctx.engine.decide(workflow.id, "approve").status, "completed");
    assert.deepEqual(ctx.peerRuns, ["api", "web"]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Người dùng có thể từ chối ngay ở bước manual verification", async () => {
  const ctx = setup("manual-verification");
  try {
    const workflow = ctx.engine.create({ title: "Board", request: "Make Mini Task Board" });
    const result = await until(ctx.store, workflow.id, ["waiting_manual_verification", "failed"]);
    assert.equal(result.status, "waiting_manual_verification");
    assert.equal(ctx.engine.decide(workflow.id, "reject").status, "rejected");
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Restart lúc integration review phải giữ an toàn và không auto dispatch", () => {
  const ctx = setup("manual-verification");
  try {
    ctx.store.addWorkflow({
      id: "pending", title: "Pending", request: "Review", status: "integration_reviewing",
      peers: [], leadTaskIds: [], reviewCount: 0, maxReworks: 2,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    assert.equal(new TaskStore(join(ctx.dir, "state")).getWorkflow("pending")?.status, "interrupted");
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Final Integration Review không tạo rework loop vô hạn", async () => {
  const ctx = setup("rework-forever");
  try {
    const workflow = ctx.engine.create({ title: "Limit", request: "Check integration until limit" });
    const result = await until(ctx.store, workflow.id, ["waiting_business_approval", "failed"]);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /giới hạn rework/);
    assert.equal(result.peers[0].attempts.length, 1);
    assert.equal(result.peers[1].attempts.length, 3);
    assert.throws(() => ctx.engine.decide(workflow.id, "approve"));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Lead tự sửa LeadPlan thiếu Acceptance Criteria, không dispatch Peer trước khi plan hợp lệ", async () => {
  const ctx = setup("manual-verification", true);
  try {
    const workflow = ctx.engine.create({ title: "Plan format", request: "Add task board" });
    const result = await until(ctx.store, workflow.id, ["waiting_manual_verification", "failed"]);
    assert.equal(result.status, "waiting_manual_verification", result.error);
    assert.equal(ctx.planCalls, 2);
    assert.equal(result.plan?.acceptanceCriteria.length, 2);
    assert.deepEqual(ctx.peerRuns, ["api", "web"]);
    assert.ok(ctx.store.events().some((evt) => evt.kind === "workflow/plan_validation_failed"));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Retry Final Integration chỉ chạy Lead, không ghi lại source từ các Peer đã accepted", async () => {
  const ctx = setup("manual-verification");
  try {
    const now = new Date().toISOString();
    ctx.store.addWorkflow({
      id: "wf-recover", title: "Recover", request: "Task board",
      status: "failed", error: "IntegrationReview sai schema sau 3 lần: missing checks",
      plan: {
        summary: "Mock plan",
        acceptanceCriteria: [
          { id: "ac-api", description: "API", verification: "Inspect API" },
          { id: "ac-ui", description: "Web", verification: "Browser check" }
        ],
        tasks: [
          { id: "api1", title: "API", moduleId: "api", instructions: "Build", dependsOn: [] },
          { id: "web1", title: "Web", moduleId: "web", instructions: "Build", dependsOn: ["api1"] }
        ]
      },
      peers: [
        { id: "api1", title: "API", moduleId: "api", instructions: "Build", dependsOn: [],
          status: "accepted", attempts: [{ iteration: 1, taskId: "old-api" }],
          result: { summary: "API complete", changedFiles: [], tests: [], risks: [] } },
        { id: "web1", title: "Web", moduleId: "web", instructions: "Build", dependsOn: ["api1"],
          status: "accepted", attempts: [{ iteration: 1, taskId: "old-web" }],
          result: { summary: "Web complete", changedFiles: [], tests: [], risks: [] } }
      ],
      leadTaskIds: [], reviewCount: 2, maxReworks: 2, createdAt: now, updatedAt: now
    });
    assert.equal(ctx.engine.retryIntegration("wf-recover").status, "integration_reviewing");
    const final = await until(ctx.store, "wf-recover", ["waiting_manual_verification", "failed"]);
    assert.equal(final.status, "waiting_manual_verification", final.error);
    assert.deepEqual(ctx.peerRuns, []);
    assert.equal(final.integrationReviewCount, 1);
    assert.throws(() => ctx.engine.retryIntegration("wf-recover"));
    assert.ok(ctx.store.events().some((evt) => evt.kind === "workflow/integration_review_resumed"));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
