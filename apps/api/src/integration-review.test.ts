import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun, WorkspaceConfig } from "@aacc/contracts";
import { WorkflowEngine } from "./workflow-engine.js";
import { TaskStore } from "./store.js";
import type { AgentTaskExecutor } from "./session-manager.js";
import type { P2Services } from "./p2-services.js";

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

function setup(mode: "integration-rework" | "manual-verification" | "manual-contract" |
  "web-rework" | "rework-forever" | "web-fallback" | "remediation-retry" |
  "collect-evidence" | "independent-test" | "verification-blocked" | "verification-limit" |
  "verification-retry",
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
  let invalidRemediationRemaining = mode === "remediation-retry" ? 3 : 0;
  let invalidVerificationRemaining = mode === "verification-retry" ? 3 : 0;
  let verifyRuns = 0;
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
          integrationContracts: [{
            id: "api-web", producerTaskId: "api1", consumerTaskId: "web1",
            deliverable: "task-board-api.js", consumerUsage: "Web must call API functions, not fallback",
            verification: "Inspect Web API imports and execute integrated addTask/changeStatus flow"
          }],
          orderingOnlyDependencies: [],
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
        if (mode === "independent-test" && task.moduleId === "web") {
          store.update(task.id, { executionCwd: web });
        }
        peerRuns.push(task.moduleId!);
        output = { summary: "Worked on " + task.moduleId, changedFiles: [], tests: [
          { status: "not_run", details: "Mock executor" }
        ], risks: [] };
      } else if (task.role === "reviewer") {
        integrations++;
        integrationPrompts.push(task.prompt);
        const base = [
          { criterionId: "ac-api", status: "passed", evidence: "API code reviewed" },
          { criterionId: "ac-ui", status: "passed", evidence: "UI integration checked" }
        ];
        const integrationPassed = [{ contractId: "api-web", status: "passed", evidence: "Mock integrated execution" }];
        if (mode === "manual-contract") {
          output = {
            summary: "Product works, contract needs test", verdict: "manual_verification",
            checks: base, contractChecks: [{
              contractId: "api-web", status: "unverified", evidence: "Consumer usage not tested"
            }], rework: []
          };
        } else if (mode === "manual-verification" || mode === "collect-evidence" ||
          mode === "independent-test" || mode === "verification-blocked" ||
          mode === "verification-limit" || mode === "verification-retry") {
          output = {
            summary: "Needs more evidence", verdict:
              (mode === "collect-evidence" && integrations > 1) ||
              (mode === "independent-test" && integrations > 1) ? "pass" : "manual_verification",
            checks: [
              base[0],
              { criterionId: "ac-ui",
                status: (mode === "collect-evidence" || mode === "independent-test") &&
                  integrations > 1 ? "passed" : "unverified",
                evidence: integrations > 1 ? "Independent evidence now available" : "Browser interaction not run" }
            ], contractChecks: integrationPassed, rework: []
          };
        } else if (integrations === 1 || mode === "rework-forever" || mode === "web-fallback") {
          output = {
            summary: "Modules are not integrated", verdict: "rework",
            checks: [
              { criterionId: "ac-api", status: mode === "integration-rework" ? "failed" : "passed",
                evidence: "Mismatch in shared API contract" },
              { criterionId: "ac-ui", status: "failed", evidence: "UI cannot call API" }
            ],
            contractChecks: [{
              contractId: "api-web", status: "failed",
              evidence: mode === "web-fallback" ? "Web only uses local fallback, not API deliverable" :
                "Consumer cannot use expected producer API artifact"
            }],
            rework: [{
              taskId: mode === "integration-rework" ? "api1" : "web1",
              feedback: "Connect the UI and API correctly"
            }]
          };
        } else {
          output = { summary: "Cross-module integration verified", verdict: "pass",
            checks: base, contractChecks: integrationPassed, rework: [] };
        }
      } else if (task.title.startsWith("Lead: quyết định xử lý kết quả chưa xác minh")) {
        const choice = mode === "collect-evidence" || mode === "verification-limit"
          ? "collect_evidence" : mode === "independent-test" ? "run_verification"
          : mode === "verification-blocked" ? "blocked" : "request_human";
        output = invalidVerificationRemaining-- > 0
          ? { decision: "accept", reason: "bad", instructions: "bad", taskIds: [] }
          : { decision: mode === "verification-limit" && integrations > 2 ? "blocked" : choice,
              reason: "Lead determines next step based on unverified finding",
              instructions: "Run test/collect evidence or ask user with concrete steps",
              taskIds: (mode === "verification-limit" && integrations > 2) ||
                ["blocked", "request_human"].includes(choice) ? [] : ["web1"] };
      } else if (task.title.startsWith("Lead: quyết định khắc phục")) {
        const match = /Independent Reviewer report \(untrusted findings\): (\{[^\n]*\})/.exec(task.prompt);
        assert.ok(match, "Lead receives independent Reviewer findings");
        const report = JSON.parse(match[1]) as { rework: Array<{taskId:string;feedback:string}> };
        output = invalidRemediationRemaining-- > 0
          ? { summary: "Invalid Lead decision", rework: [] }
          : { summary: "Lead quyết định sửa đúng Peer theo kết quả Reviewer",
              rework: report.rework.map((item) => ({ ...item, feedback: "Lead: " + item.feedback })) };
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
  if (mode === "independent-test") {
    config.modules[1].testCommand = ["node", "--version"];
  }
  const fakeP2 = mode === "independent-test" ? {
    async capture(_task: unknown, evidence: { verifiedTest?: {status: "passed"} }) {
      verifyRuns++;
      evidence.verifiedTest = { status: "passed" };
      return evidence;
    }
  } as unknown as P2Services : undefined;
  return { dir, store, peerRuns, integrationPrompts,
    get planCalls() { return planCalls; },
    get verifyRuns() { return verifyRuns; },
    engine: new WorkflowEngine(config, store, executor, fakeP2) };
}

test("Final review phát hiện API mismatch, rework API và downstream Web, sau đó mới Business Approval", async () => {
  const ctx = setup("integration-rework");
  try {
    const workflow = ctx.engine.create({ title: "Board", request: "Make Mini Task Board" });
    const result = await until(ctx.store, workflow.id, ["waiting_business_approval", "failed"]);
    assert.equal(result.status, "waiting_business_approval", result.error);
    assert.equal(result.integrationReviewCount, 2);
    assert.equal(result.reviewerTaskIds?.length, 2);
    assert.ok(result.reviewerTaskIds!.every((id) => ctx.store.get(id)?.role === "reviewer"));
    assert.ok(result.leadTaskIds.every((id) => ctx.store.get(id)?.role === "lead"));
    assert.equal(result.lastRemediation, undefined);
    assert.equal(result.finalReview?.verdict, "pass");
    assert.deepEqual(ctx.peerRuns, ["api", "web", "api", "web"]);
    assert.ok(ctx.store.events().some((event) => event.kind === "workflow/lead_remediation"));
    assert.deepEqual(result.peers.map((p) => p.attempts.length), [2, 2]);
    assert.match(ctx.integrationPrompts[0], /REQUIRED_CRITERION_IDS/);
    assert.match(ctx.integrationPrompts[0], /REQUIRED_CONTRACT_IDS/);
    assert.equal(result.finalReview?.contractChecks[0].status, "passed");
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

test("Retry Final Integration chỉ chạy Reviewer, không ghi lại source từ các Peer đã accepted", async () => {
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
        integrationContracts: [{
          id: "api-web", producerTaskId: "api1", consumerTaskId: "web1",
          deliverable: "task-board-api.js", consumerUsage: "Web calls API",
          verification: "Run cross-module test"
        }],
        orderingOnlyDependencies: [],
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
    assert.equal(final.reviewerTaskIds?.length, 1);
    assert.equal(ctx.store.get(final.reviewerTaskIds![0])?.role, "reviewer");
    assert.throws(() => ctx.engine.retryIntegration("wf-recover"));
    assert.ok(ctx.store.events().some((evt) => evt.kind === "workflow/integration_review_resumed"));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Product Acceptance pass không thể che giấu Web fallback sai Integration Contract", async () => {
  const ctx = setup("web-fallback");
  try {
    const workflow = ctx.engine.create({ title: "Fallback", request: "Web must use shared API" });
    const result = await until(ctx.store, workflow.id, ["failed", "waiting_business_approval"]);
    assert.equal(result.status, "failed", "Repeated fallback must not reach Business Approval");
    assert.deepEqual(ctx.peerRuns, ["api", "web", "web", "web"]);
    assert.match(result.error ?? "", /giới hạn rework/);
    assert.equal(result.finalReview?.contractChecks[0].status, "failed");
    assert.equal(result.finalReview?.checks[0].status, "passed");
    assert.throws(() => ctx.engine.decide(workflow.id, "approve"));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Contract unverified phải xác nhận riêng, không được dùng checkbox sản phẩm thay thế", async () => {
  const ctx = setup("manual-contract");
  try {
    const workflow = ctx.engine.create({ title: "Contract", request: "Verify handoff" });
    const result = await until(ctx.store, workflow.id, ["waiting_manual_verification", "failed"]);
    assert.equal(result.status, "waiting_manual_verification", result.error);
    assert.ok(result.finalReview?.checks.every((item) => item.status === "passed"));
    assert.equal(result.finalReview?.contractChecks[0].status, "unverified");
    assert.throws(() => ctx.engine.confirmManualVerification(workflow.id, []), /xác nhận/);
    assert.throws(() => ctx.engine.confirmManualVerification(workflow.id, [], ["other"]), /xác nhận/);
    assert.equal(ctx.engine.confirmManualVerification(workflow.id, [], ["api-web"]).status,
      "waiting_business_approval");
    assert.deepEqual(ctx.store.getWorkflow(workflow.id)?.manualVerifiedContractIds, ["api-web"]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("LeadRemediation sai schema có thể retry Lead-only; giữ Reviewer report/PeerResults", async () => {
  const ctx = setup("remediation-retry");
  try {
    const workflow = ctx.engine.create({ title: "Remediation", request: "Fix integration" });
    const failed = await until(ctx.store, workflow.id, ["failed", "waiting_business_approval"]);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /LeadRemediation sai schema/);
    assert.equal(failed.finalReview?.verdict, "rework");
    assert.equal(failed.reviewerTaskIds?.length, 1);
    assert.deepEqual(ctx.peerRuns, ["api", "web"]);
    assert.equal(ctx.engine.retryIntegration(workflow.id).status, "integration_reviewing");
    const recovered = await until(ctx.store, workflow.id, ["waiting_business_approval", "failed"]);
    assert.equal(recovered.status, "waiting_business_approval", recovered.error);
    assert.deepEqual(ctx.peerRuns, ["api", "web", "web"]);
    assert.equal(recovered.reviewerTaskIds?.length, 2,
      "No Reviewer rerun during remediation retry; fresh Reviewer runs after Peer rework");
    assert.equal(recovered.integrationReviewCount, 2);
    assert.ok(ctx.store.events().some(e => e.kind === "workflow/lead_remediation"));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("UNVERIFIED: Lead collects evidence from Peer; fresh Reviewer rechecks; no Human gate", async () => {
  const ctx = setup("collect-evidence");
  try {
    const started = ctx.engine.create({title: "Evidence", request: "Check UI"});
    const result = await until(ctx.store, started.id, ["waiting_business_approval", "failed"]);
    assert.equal(result.status, "waiting_business_approval", result.error);
    assert.deepEqual(ctx.peerRuns, ["api", "web", "web"]);
    assert.equal(result.verificationRounds, 1);
    assert.equal(result.integrationReviewCount, 2);
    assert.equal(result.lastVerificationDecision?.decision, "collect_evidence");
    assert.ok(ctx.store.events().some(e => e.kind === "workflow/lead_verification_decision"));
    assert.ok(result.reviewerTaskIds?.length === 2);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("UNVERIFIED: Lead requests independent configured verification, then fresh Reviewer, no Peer rework", async () => {
  const ctx = setup("independent-test");
  try {
    const started = ctx.engine.create({title: "Verify", request: "Verify UI"});
    const result = await until(ctx.store, started.id, ["waiting_business_approval", "failed"]);
    assert.equal(result.status, "waiting_business_approval", result.error);
    assert.deepEqual(ctx.peerRuns, ["api", "web"]);
    assert.equal(result.verificationRounds, 1);
    assert.equal(result.integrationReviewCount, 2);
    assert.ok(ctx.verifyRuns >= 2, "Independent P2 runner called after Lead decision");
    assert.equal(result.lastVerificationDecision?.decision, "run_verification");
    assert.equal(result.peers[1].evidence?.verifiedTest?.status, "passed");
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("UNVERIFIED: Lead can block; Business Approval unavailable", async () => {
  const ctx = setup("verification-blocked");
  try {
    const started = ctx.engine.create({title: "Blocked", request: "Unavailable access"});
    const result = await until(ctx.store, started.id, ["blocked", "failed"]);
    assert.equal(result.status, "blocked", result.error);
    assert.match(result.blocker ?? "", /Lead determines next step/);
    assert.equal(result.lastVerificationDecision?.decision, "blocked");
    assert.throws(() => ctx.engine.decide(started.id, "approve"), /Business Approval/);
    assert.equal(ctx.engine.decide(started.id, "reject").status, "rejected");
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("UNVERIFIED: bounded verification loops; Lead chooses blocked after two rounds", async () => {
  const ctx = setup("verification-limit");
  try {
    const started = ctx.engine.create({title: "Limit", request: "Need evidence"});
    const result = await until(ctx.store, started.id, ["blocked", "failed"]);
    assert.equal(result.status, "blocked", result.error);
    assert.equal(result.verificationRounds, 2);
    assert.equal(result.integrationReviewCount, 3);
    assert.deepEqual(ctx.peerRuns, ["api", "web", "web", "web"]);
    assert.equal(result.lastVerificationDecision?.decision, "blocked");
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("UNVERIFIED: malformed Lead schema retries Lead-only and keeps Reviewer report", async () => {
  const ctx = setup("verification-retry");
  try {
    const started = ctx.engine.create({title: "Retry", request: "Need human check"});
    const failed = await until(ctx.store, started.id, ["failed", "waiting_manual_verification"]);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /LeadVerification sai schema/);
    assert.equal(failed.reviewerTaskIds?.length, 1);
    assert.deepEqual(ctx.peerRuns, ["api", "web"]);
    assert.equal(ctx.engine.retryIntegration(started.id).status, "integration_reviewing");
    const recovered = await until(ctx.store, started.id, ["waiting_manual_verification", "failed"]);
    assert.equal(recovered.status, "waiting_manual_verification", recovered.error);
    assert.equal(recovered.reviewerTaskIds?.length, 1);
    assert.deepEqual(ctx.peerRuns, ["api", "web"]);
    assert.equal(recovered.lastVerificationDecision?.decision, "request_human");
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});
