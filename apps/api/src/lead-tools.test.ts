import assert from "node:assert/strict";
import { test } from "node:test";
import { commandFromTool, leadDynamicTools } from "./lead-tools.js";

test("Dynamic tool schemas expose only Lead routing operations", () => {
  assert.deepEqual(leadDynamicTools.map(t => t.name), ["spawn_peer", "send_peer", "spawn_discovery", "send_discovery", "update_task_brief", "finish"]);
  assert.ok(leadDynamicTools.every(t => t.inputSchema.additionalProperties === false));
  const spawn = leadDynamicTools.find(t => t.name === "spawn_peer")!;
  assert.ok("model" in spawn.inputSchema.properties);
  assert.ok("effort" in spawn.inputSchema.properties);
  const discovery = leadDynamicTools.find(t => t.name === "spawn_discovery")!;
  assert.deepEqual(discovery.inputSchema.required, ["message", "expectedResult"]);
  const sendDiscovery = leadDynamicTools.find(t => t.name === "send_discovery")!;
  assert.deepEqual(sendDiscovery.inputSchema.required, ["sessionId", "message", "expectedResult"]);
  const brief = leadDynamicTools.find(t => t.name === "update_task_brief")!;
  assert.deepEqual(brief.inputSchema.required, ["brief"]);
  assert.deepEqual(spawn.inputSchema.required, ["moduleId", "message", "expectedResult"]);
  const finish = leadDynamicTools.find(t => t.name === "finish")!;
  assert.deepEqual(finish.inputSchema.properties, {});
  assert.equal(finish.inputSchema.additionalProperties, false);
});
test("Tool transport requires self-contained assignments and preserves refs", () => {
  const message = 'API contract: GET /api/todos → {"todos":[{"id":1,"completed":false}]}';
  const expectedResult = "Confirm API contract and report tests";
  const refs = ["message-discovery"];
  assert.deepEqual(commandFromTool("spawn_peer", {
    moduleId: "web", label: "Todo Web", message, expectedResult, contextRefs: refs
  }), { type: "spawn_peer", moduleId: "web", label: "Todo Web",
    message, expectedResult, contextRefs: refs });
  assert.deepEqual(commandFromTool("spawn_peer", {
    moduleId: "web", message, expectedResult, model: "custom-model", effort: "high"
  }), { type: "spawn_peer", moduleId: "web", message, expectedResult,
    contextRefs: [], model: "custom-model", effort: "high" });
  assert.deepEqual(commandFromTool("send_peer", {
    sessionId: "s1", message, expectedResult
  }), { type: "send_peer", sessionId: "s1", message, expectedResult, contextRefs: [] });
  assert.deepEqual(commandFromTool("spawn_discovery", { message, expectedResult }),
    { type: "spawn_discovery", message, expectedResult, contextRefs: [] });
  assert.deepEqual(commandFromTool("send_discovery", {
    sessionId: "d1", message, expectedResult
  }), { type: "send_discovery", sessionId: "d1", message, expectedResult, contextRefs: [] });
  assert.throws(() => commandFromTool("spawn_peer", {
    moduleId: "api", message
  }), /expectedResult/);
  assert.throws(() => commandFromTool("spawn_discovery", { message }), /expectedResult/);
  assert.throws(() => commandFromTool("send_peer", { sessionId: "s1", message }), /expectedResult/);
  assert.throws(() => commandFromTool("spawn_peer", {
    moduleId: "web", message, expectedResult, contextRefs: ["id", "id"]
  }), /contextRefs/);
  assert.throws(() => commandFromTool("finish", { summary: "Done" }), /không nhận tham số/);
  assert.deepEqual(commandFromTool("finish", {}), { type: "finish" });
  assert.throws(() => commandFromTool("spawn_peer", { moduleId: "api" }), /message/);
  assert.throws(() => commandFromTool("shell_exec", { command: "ls" }), /Unknown Lead tool/);
  assert.throws(() => commandFromTool("send_peer", {
    sessionId: 123, message, expectedResult
  }), /sessionId/);
  assert.throws(() => commandFromTool("spawn_peer", {
    moduleId: "web", message, expectedResult, model: "x".repeat(129)
  }), /model/);
});

test("Task Brief tool validates structured evidence references", () => {
  const brief = {
    goal: "Todo List", acceptanceCriteria: ["CRUD works"],
    verified: [{ finding: "API tested", evidenceRefs: ["peer-result"] }],
    preliminary: ["Web may need type fix"], unknowns: ["Browser E2E"],
    nextDecision: "Ask Peer to validate integration"
  };
  assert.deepEqual(commandFromTool("update_task_brief", { brief }),
    { type: "update_task_brief", brief });
  assert.throws(() => commandFromTool("update_task_brief", {
    brief: { ...brief, verified: [{ finding: "API tested", evidenceRefs: [] }] }
  }), /evidenceRefs/);
  assert.throws(() => commandFromTool("update_task_brief", { brief: null }), /brief/);
});
