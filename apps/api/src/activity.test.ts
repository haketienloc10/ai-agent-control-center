import assert from "node:assert/strict";
import { test } from "node:test";
import { projectActivity } from "./activity.js";
import type { ActivityEntry, ActivityEvent } from "@aacc/contracts";

let sequence = 0;
function event(taskId: string, kind: string, data: unknown): ActivityEvent {
  return { id: String(++sequence), taskId, kind, data, createdAt: new Date().toISOString() };
}
test("gom deltas theo itemId và dùng final agent message khi hoàn thành", () => {
  const activities: ActivityEntry[] = [];
  projectActivity(activities, event("a", "item/started", { item: { id: "m1", type: "agentMessage" }, itemId: "m1" }));
  for (const delta of ['{ "sum', 'mary": "', 'Hoàn thành" }']) {
    projectActivity(activities, event("a", "item/agentMessage/delta", { itemId: "m1", delta }));
  }
  assert.equal(activities.length, 1);
  assert.equal(activities[0].detail, '{ "summary": "Hoàn thành" }');
  projectActivity(activities, event("a", "item/completed", { itemId: "m1", item: { type: "agentMessage", text: '{ "summary": "Hoàn thành" }' } }));
  assert.equal(activities.length, 1);
  assert.equal(activities[0].status, "completed");
  assert.equal(activities[0].title, "Agent đã trả kết quả");
});
test("phân biệt 2 message và 2 Agent khác nhau", () => {
  const activities: ActivityEntry[] = [];
  projectActivity(activities, event("a", "item/agentMessage/delta", { itemId: "m1", delta: "A" }));
  projectActivity(activities, event("b", "item/agentMessage/delta", { itemId: "m1", delta: "B" }));
  projectActivity(activities, event("a", "item/agentMessage/delta", { itemId: "m2", delta: "C" }));
  assert.equal(activities.length, 3);
});
test("command exit code, workflow event và runtime error có ý nghĩa với người dùng", () => {
  const activities: ActivityEntry[] = [];
  projectActivity(activities, event("a", "item/started", { itemId: "c1", item: { type: "commandExecution", command: "npm test" } }));
  projectActivity(activities, event("a", "item/completed", { itemId: "c1", item: { type: "commandExecution", command: "npm test", exitCode: 1 } }));
  projectActivity(activities, event("workflow:w", "workflow/review", { reviews: [{ decision: "accept" }, { decision: "rework" }] }));
  projectActivity(activities, event("a", "runtime/error", { message: "RPC timeout" }));
  assert.equal(activities[0].status, "failed");
  assert.match(activities[0].detail, /Exit code: 1/);
  assert.match(activities[1].detail, /1 chấp nhận · 1 cần sửa lại/);
  assert.equal(activities[2].title, "Agent gặp lỗi");
});
test("không tạo nhiều entry từ command output chunks", () => {
  const activities: ActivityEntry[] = [];
  for (let i = 0; i < 100; i++) projectActivity(activities, event("a", "item/commandExecution/outputDelta", { delta: "line" }));
  assert.equal(activities.length, 0);
});
