import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentJson, validateIntegrationReview, validateLeadRemediation, validateLeadPlan, validateLeadReview, validatePeerResult } from "./workflow-contracts.js";
import type { WorkspaceConfig } from "@aacc/contracts";
const config: WorkspaceConfig = {
  lead: { cwd: "/tmp/lead", instructions: "" },
  modules: [{ id: "api", label: "API", path: "/tmp/api" }, { id: "web", label: "Web", path: "/tmp/web" }]
};
const plan = {
  summary: "Triển khai hai module",
  acceptanceCriteria: [{ id: "ac1", description: "UI kết nối API", verification: "Chạy thử demo" }],
  integrationContracts: [{
    id: "contract-api-web", producerTaskId: "api1", consumerTaskId: "web1",
    deliverable: "task-board-api.js", consumerUsage: "Web calls API functions",
    verification: "Verify Web uses exported API functions and test integration"
  }],
  orderingOnlyDependencies: [],
  tasks: [
    { id: "api1", moduleId: "api", title: "API", instructions: "Build API", dependsOn: [] },
    { id: "web1", moduleId: "web", title: "Web", instructions: "Build UI", dependsOn: ["api1"] }
  ]
};
test("chấp nhận JSON thuần hoặc fenced JSON", () => {
  assert.deepEqual(parseAgentJson(JSON.stringify(plan)), plan);
  assert.deepEqual(parseAgentJson("\x60\x60\x60json\n" + JSON.stringify(plan) + "\n\x60\x60\x60"), plan);
  assert.throws(() => parseAgentJson("Here: " + JSON.stringify(plan)));
});
test("LeadPlan xác thực module, dependency và cycle", () => {
  assert.equal(validateLeadPlan(plan, config).tasks.length, 2);
  assert.throws(() => validateLeadPlan({ ...plan, tasks: [{ ...plan.tasks[0], moduleId: "evil" }] }, config));
  assert.throws(() => validateLeadPlan({ ...plan, tasks: [
    { ...plan.tasks[0], dependsOn: ["web1"] }, plan.tasks[1]
  ] }, config), /cycle/);
});
test("PeerResult có test evidence và review phủ hết batch", () => {
  const result = validatePeerResult({ summary: "done", changedFiles: [], tests: [
    { command: "npm test", status: "passed" }
  ], risks: [] });
  assert.equal(result.tests[0].status, "passed");
  assert.throws(() => validateLeadReview({ summary: "ok", reviews: [] }, ["api1"]));
  assert.equal(validateLeadReview({ summary: "ok", reviews: [
    { taskId: "api1", decision: "accept", feedback: "Đạt" }
  ] }, ["api1"]).reviews.length, 1);
});

test("not_run cho phép không có command, nhưng passed/failed bắt buộc command", () => {
  for (const command of ["", null, undefined]) {
    const result = validatePeerResult({
      summary: "Không có test framework", changedFiles: ["index.html"],
      tests: [{ command, status: "not_run", details: "Chưa cài test runner" }], risks: []
    });
    assert.equal(result.tests[0].status, "not_run");
    assert.equal(result.tests[0].command, undefined);
  }
  assert.throws(() => validatePeerResult({
    summary: "Sai", changedFiles: [], tests: [{ status: "passed", command: "" }], risks: []
  }), /test.command bắt buộc/);
  assert.equal(validatePeerResult({
    summary: "Đã thử", changedFiles: [], tests: [{ status: "passed", command: "npm test" }], risks: []
  }).tests[0].command, "npm test");
});

test("Acceptance Criteria bắt buộc, không chấp nhận IDs trùng", () => {
  assert.throws(() => validateLeadPlan({ ...plan, acceptanceCriteria: [] }, config), /acceptanceCriteria/);
  assert.throws(() => validateLeadPlan({ ...plan, acceptanceCriteria: [
    plan.acceptanceCriteria[0], plan.acceptanceCriteria[0]
  ] }, config), /criterion.id/);
});
test("Final Integration Review chặn pass khi unverified/failed, bắt buộc evidence và Peer IDs hợp lệ", () => {
  const criterionIds = ["ac1", "ac2"];
  const peerIds = ["api1", "web1"];
  const checks = [
    { criterionId: "ac1", status: "passed", evidence: "Read API source" },
    { criterionId: "ac2", status: "unverified", evidence: "Chưa chạy browser" }
  ];
  assert.throws(() => validateIntegrationReview({
    summary: "Tạm", verdict: "pass", checks, contractChecks: [], rework: []
  }, criterionIds, peerIds), /không được pass/);
  assert.equal(validateIntegrationReview({
    summary: "Manual", verdict: "manual_verification", checks, contractChecks: [], rework: []
  }, criterionIds, peerIds).verdict, "manual_verification");
  assert.throws(() => validateIntegrationReview({
    summary: "Sai", verdict: "manual_verification", checks: [checks[0], checks[0]], contractChecks: [], rework: []
  }, criterionIds, peerIds), /criterionId/);
  assert.throws(() => validateIntegrationReview({
    summary: "Sai", verdict: "rework", checks: [
      checks[0], { ...checks[1], status: "failed" }
    ], contractChecks: [], rework: [{ taskId: "bad", feedback: "Repair" }]
  }, criterionIds, peerIds), /taskId/);
});

test("Cross-module dependencies phải được phân loại rõ integration hoặc ordering-only", () => {
  const noContracts = { ...plan, integrationContracts: [], orderingOnlyDependencies: [] };
  assert.throws(() => validateLeadPlan(noContracts, config), /Thiếu phân loại dependency/);
  const ordering = { ...plan, integrationContracts: [],
    orderingOnlyDependencies: [{ producerTaskId: "api1", consumerTaskId: "web1",
      reason: "Chỉ chờ API hoàn thành khảo sát, Web độc lập" }] };
  assert.equal(validateLeadPlan(ordering, config).integrationContracts.length, 0);
  assert.equal(validateLeadPlan(plan, config).integrationContracts[0].id, "contract-api-web");
  assert.throws(() => validateLeadPlan({
    ...plan, orderingOnlyDependencies: ordering.orderingOnlyDependencies
  }, config), /khai báo trùng/);
  assert.throws(() => validateLeadPlan({
    ...plan, integrationContracts: [{ ...plan.integrationContracts[0], consumerTaskId: "api1" }]
  }, config), /edge không hợp lệ/);
});

test("Không thể pass Integration Acceptance khi hợp đồng fail hoặc chưa xác minh", () => {
  const product = [{ criterionId: "ac1", status: "passed", evidence: "UI works" }];
  const contracts = [{ contractId: "contract-api-web", status: "unverified", evidence: "No integration test" }];
  assert.throws(() => validateIntegrationReview({
    summary: "UI chạy độc lập", verdict: "pass", checks: product, contractChecks: contracts, rework: []
  }, ["ac1"], ["api1", "web1"], ["contract-api-web"]), /không được pass/);
  assert.throws(() => validateIntegrationReview({
    summary: "UI chạy độc lập", verdict: "pass", checks: product, contractChecks: [], rework: []
  }, ["ac1"], ["api1", "web1"], ["contract-api-web"]), /integration contract/);
  assert.equal(validateIntegrationReview({
    summary: "Chờ xác minh", verdict: "manual_verification", checks: product,
    contractChecks: contracts, rework: []
  }, ["ac1"], ["api1", "web1"], ["contract-api-web"]).verdict, "manual_verification");
  assert.equal(validateIntegrationReview({
    summary: "Fallback is wrong", verdict: "rework", checks: product,
    contractChecks: [{ ...contracts[0], status: "failed", evidence: "Web only runs mock" }],
    rework: [{ taskId: "web1", feedback: "Use API artifact" }]
  }, ["ac1"], ["api1", "web1"], ["contract-api-web"]).verdict, "rework");
});

test("Lead remediation chỉ chọn Peer hợp lệ, có chỉ dẫn và không được chọn 0 Peer", () => {
  const ids = ["api1", "web1"];
  assert.throws(() => validateLeadRemediation({ summary: "Skip failure", rework: [] }, ids), /ít nhất một/);
  assert.throws(() => validateLeadRemediation({
    summary: "Invalid", rework: [{ taskId: "unknown", feedback: "Fix" }]
  }, ids), /taskId/);
  assert.throws(() => validateLeadRemediation({
    summary: "Duplicate", rework: [
      { taskId: "api1", feedback: "Fix" }, { taskId: "api1", feedback: "Fix again" }
    ]
  }, ids), /taskId/);
  assert.deepEqual(validateLeadRemediation({
    summary: "Fix integration",
    rework: [{ taskId: "web1", feedback: "Kết nối API thực tế thay vì fallback" }]
  }, ids).rework.map((x) => x.taskId), ["web1"]);
});
