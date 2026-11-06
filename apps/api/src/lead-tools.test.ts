import assert from "node:assert/strict";
import { test } from "node:test";
import { commandFromTool, leadDynamicTools } from "./lead-tools.js";

test("Dynamic tool schemas expose only Lead routing operations", () => {
  assert.deepEqual(leadDynamicTools.map(t => t.name), ["assign_module", "record_decision", "spawn_discovery", "send_discovery", "update_task_brief", "finish"]);
  assert.ok(leadDynamicTools.every(t => t.inputSchema.additionalProperties === false));
  const assign = leadDynamicTools.find(t => t.name === "assign_module")!;
  assert.ok("model" in assign.inputSchema.properties);
  assert.ok("effort" in assign.inputSchema.properties);
  assert.ok("constraints" in assign.inputSchema.properties);
  assert.ok("previousContext" in assign.inputSchema.properties);
  assert.ok(!("label" in assign.inputSchema.properties), "Peer identity is the module, not a free label");
  assert.ok(!("sessionId" in assign.inputSchema.properties));
  assert.deepEqual(assign.inputSchema.required, ["moduleId", "message", "expectedResult"]);
  const decision = leadDynamicTools.find(t => t.name === "record_decision")!;
  assert.deepEqual(decision.inputSchema.required, ["topic", "decision", "rationale", "affects"]);
  const discovery = leadDynamicTools.find(t => t.name === "spawn_discovery")!;
  assert.deepEqual(discovery.inputSchema.required, ["message", "expectedResult"]);
  const sendDiscovery = leadDynamicTools.find(t => t.name === "send_discovery")!;
  assert.deepEqual(sendDiscovery.inputSchema.required, ["sessionId", "message", "expectedResult"]);
  const brief = leadDynamicTools.find(t => t.name === "update_task_brief")!;
  assert.deepEqual(brief.inputSchema.required, ["brief"]);
  const finish = leadDynamicTools.find(t => t.name === "finish")!;
  assert.deepEqual(finish.inputSchema.properties, {});
  assert.equal(finish.inputSchema.additionalProperties, false);
});
test("Peer tool validates Lead-authored constraints and previous context summaries", () => {
  const input = { moduleId: "api", message: "Bổ sung validation", expectedResult: "Báo bằng chứng",
    contextRefs: ["r1"], constraints: ["Giữ dữ liệu"], previousContext: [{ messageId: "r1", summary: "Còn thiếu validation" }] };
  assert.deepEqual(commandFromTool("assign_module", input), { type: "assign_module", ...input });
  for (const constraints of [null, "bad", [""], Array(21).fill("x"), ["x".repeat(2001)]]) {
    assert.throws(() => commandFromTool("assign_module", { ...input, constraints }), /constraint/);
  }
  for (const previousContext of [null, [null], [{ messageId: "r1", summary: "" }],
    [{ messageId: "r1", summary: "a" }, { messageId: "r1", summary: "b" }], Array(9).fill({ messageId: "r1", summary: "s" })]) {
    assert.throws(() => commandFromTool("assign_module", { ...input, previousContext }), /previousContext/);
  }
});
test("Tool transport requires self-contained assignments and preserves refs", () => {
  const message = 'API contract: GET /api/todos → {"todos":[{"id":1,"completed":false}]}';
  const expectedResult = "Confirm API contract and report tests";
  const refs = ["message-discovery"];
  assert.deepEqual(commandFromTool("assign_module", {
    moduleId: "web", message, expectedResult, contextRefs: refs
  }), { type: "assign_module", moduleId: "web", message, expectedResult, contextRefs: refs });
  assert.deepEqual(commandFromTool("assign_module", {
    moduleId: "web", message, expectedResult, model: "custom-model", effort: "high"
  }), { type: "assign_module", moduleId: "web", message, expectedResult,
    contextRefs: [], model: "custom-model", effort: "high" });
  assert.deepEqual(commandFromTool("spawn_discovery", { message, expectedResult }),
    { type: "spawn_discovery", message, expectedResult, contextRefs: [] });
  assert.deepEqual(commandFromTool("send_discovery", {
    sessionId: "d1", message, expectedResult
  }), { type: "send_discovery", sessionId: "d1", message, expectedResult, contextRefs: [] });
  assert.throws(() => commandFromTool("assign_module", {
    moduleId: "api", message
  }), /expectedResult/);
  assert.throws(() => commandFromTool("spawn_discovery", { message }), /expectedResult/);
  assert.throws(() => commandFromTool("assign_module", {
    moduleId: "web", message, expectedResult, contextRefs: ["id", "id"]
  }), /contextRefs/);
  assert.throws(() => commandFromTool("finish", { summary: "Done" }), /không nhận tham số/);
  assert.deepEqual(commandFromTool("finish", {}), { type: "finish" });
  assert.throws(() => commandFromTool("assign_module", { moduleId: "api" }), /message/);
  assert.throws(() => commandFromTool("shell_exec", { command: "ls" }), /Unknown Lead tool/);
  assert.throws(() => commandFromTool("send_peer", { sessionId: "s1", message, expectedResult }),
    /Unknown Lead tool/, "Peers are addressed by module only");
  assert.throws(() => commandFromTool("assign_module", {
    moduleId: "web", message, expectedResult, model: "x".repeat(129)
  }), /model/);
});
test("Decision tool requires a topic, rationale and at least one distinct affected module", () => {
  const input = { topic: "api-contract", decision: "GET /api/todos", rationale: "Hai module dùng chung",
    affects: ["api", "web"], evidenceRefs: ["m1"] };
  assert.deepEqual(commandFromTool("record_decision", input), { type: "record_decision", ...input });
  assert.deepEqual(commandFromTool("record_decision", { ...input, evidenceRefs: undefined }),
    { type: "record_decision", ...input, evidenceRefs: [] });
  assert.throws(() => commandFromTool("record_decision", { ...input, affects: [] }), /affects/);
  assert.throws(() => commandFromTool("record_decision", { ...input, affects: ["api", "api"] }), /affects/);
  assert.throws(() => commandFromTool("record_decision", { ...input, rationale: " " }), /rationale/);
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
