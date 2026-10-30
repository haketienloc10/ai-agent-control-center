import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentJson, validateLeadPlan, validateLeadReview, validatePeerResult } from "./workflow-contracts.js";
import type { WorkspaceConfig } from "@aacc/contracts";
const config: WorkspaceConfig = {
  lead: { cwd: "/tmp/lead", instructions: "" },
  modules: [{ id: "api", label: "API", path: "/tmp/api" }, { id: "web", label: "Web", path: "/tmp/web" }]
};
const plan = {
  summary: "Triển khai hai module",
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
