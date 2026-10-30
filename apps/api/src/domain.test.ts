import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask, assertTransition, cwdForTask } from "./domain.js";
import type { WorkspaceConfig } from "@aacc/contracts";

const config: WorkspaceConfig = {
  lead: { cwd: "/tmp/shared", instructions: "Lead" },
  modules: [{ id: "api", label: "API", path: "/tmp/api" }]
};

test("Lead và Peer sử dụng đúng workspace đã đăng ký", () => {
  const lead = createTask({ title: "Plan", prompt: "Plan feature", role: "lead" }, config);
  const peer = createTask({ title: "Code", prompt: "Build feature", role: "peer", moduleId: "api" }, config);
  assert.equal(cwdForTask(lead, config), "/tmp/shared");
  assert.equal(cwdForTask(peer, config), "/tmp/api");
});
test("Peer không được truyền module không đăng ký", () => {
  assert.throws(() => createTask({ title: "Oops", prompt: "x", role: "peer", moduleId: "../secret" }, config));
});
test("Task lifecycle không cho chuyển thẳng queued thành completed", () => {
  assert.throws(() => assertTransition("queued", "completed"));
  assert.doesNotThrow(() => assertTransition("queued", "starting"));
});
