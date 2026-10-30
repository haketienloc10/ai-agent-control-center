import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentJson, validateIntegrationReview, validateLeadPlan, validateLeadReview, validatePeerResult } from "./workflow-contracts.js";
import type { WorkspaceConfig } from "@aacc/contracts";
const config: WorkspaceConfig = {
  lead: { cwd: "/tmp/lead", instructions: "" },
  modules: [{ id: "api", label: "API", path: "/tmp/api" }, { id: "web", label: "Web", path: "/tmp/web" }]
};
const plan = {
  summary: "Triển khai hai module",
  acceptanceCriteria: [{ id: "ac1", description: "UI kết nối API", verification: "Chạy thử demo" }],
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
    summary: "Tạm", verdict: "pass", checks, rework: []
  }, criterionIds, peerIds), /không được pass/);
  assert.equal(validateIntegrationReview({
    summary: "Manual", verdict: "manual_verification", checks, rework: []
  }, criterionIds, peerIds).verdict, "manual_verification");
  assert.throws(() => validateIntegrationReview({
    summary: "Sai", verdict: "manual_verification", checks: [checks[0], checks[0]], rework: []
  }, criterionIds, peerIds), /criterionId/);
  assert.throws(() => validateIntegrationReview({
    summary: "Sai", verdict: "rework", checks: [
      checks[0], { ...checks[1], status: "failed" }
    ], rework: [{ taskId: "bad", feedback: "Repair" }]
  }, criterionIds, peerIds), /taskId/);
});
