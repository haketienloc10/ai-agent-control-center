import assert from "node:assert/strict";
import { test } from "node:test";
import { commandFromTool, leadDynamicTools } from "./lead-tools.js";

test("Dynamic tool schemas expose only Lead routing operations", () => {
  assert.deepEqual(leadDynamicTools.map(t => t.name), ["spawn_peer", "send_peer", "spawn_discovery", "send_discovery", "finish"]);
  assert.ok(leadDynamicTools.every(t => t.inputSchema.additionalProperties === false));
  const spawn = leadDynamicTools.find(t => t.name === "spawn_peer")!;
  assert.ok("model" in spawn.inputSchema.properties);
  assert.ok("effort" in spawn.inputSchema.properties);
  const discovery = leadDynamicTools.find(t => t.name === "spawn_discovery")!;
  assert.deepEqual(discovery.inputSchema.required, ["message"]);
  const sendDiscovery = leadDynamicTools.find(t => t.name === "send_discovery")!;
  assert.deepEqual(sendDiscovery.inputSchema.required, ["sessionId", "message"]);
  const finish = leadDynamicTools.find(t => t.name === "finish")!;
  assert.deepEqual(finish.inputSchema.properties, {});
  assert.equal(finish.inputSchema.additionalProperties, false);
});
test("Tool transport preserves nested API JSON without manual outer escaping", () => {
  const message = 'API contract: GET /api/todos → {"todos":[{"id":1,"completed":false}]}';
  assert.deepEqual(commandFromTool("spawn_peer", {
    moduleId: "web", label: "Todo Web", message
  }), { type: "spawn_peer", moduleId: "web", label: "Todo Web", message });
  assert.deepEqual(commandFromTool("spawn_peer", {
    moduleId: "web", message, model: "custom-model", effort: "high"
  }), {
    type: "spawn_peer", moduleId: "web", message, model: "custom-model", effort: "high"
  });
  assert.deepEqual(commandFromTool("send_peer", { sessionId: "s1", message }),
    { type: "send_peer", sessionId: "s1", message });
  assert.deepEqual(commandFromTool("spawn_discovery", { message }), {
    type: "spawn_discovery", message
  });
  assert.deepEqual(commandFromTool("send_discovery", { sessionId: "d1", message }), {
    type: "send_discovery", sessionId: "d1", message
  });
  assert.throws(() => commandFromTool("spawn_discovery", {}), /message/);
  assert.throws(() => commandFromTool("send_discovery", { sessionId: "d1" }), /message/);
  assert.deepEqual(commandFromTool("finish", {}), { type: "finish" });
  assert.throws(() => commandFromTool("finish", { summary: "Done" }), /không nhận tham số/);
  assert.throws(() => commandFromTool("spawn_peer", { moduleId: "api" }), /message/);
  assert.throws(() => commandFromTool("shell_exec", { command: "ls" }), /Unknown Lead tool/);
  assert.throws(() => commandFromTool("send_peer", { sessionId: 123, message }), /sessionId/);
  assert.throws(() => commandFromTool("spawn_peer", {
    moduleId: "web", message, model: "x".repeat(129)
  }), /model/);
});
