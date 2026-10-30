import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityEntry, Task, WorkflowRun } from "@aacc/contracts";
import { activitySource, matchesActivityFilter, readableDetail, shortDetail } from "./activity-view.js";

const entry = (detail: string, status: ActivityEntry["status"] = "completed"): ActivityEntry => ({
  id: "a1", taskId: "lead1", title: "Agent đã trả kết quả", detail, type: "message",
  status, source: "item/completed", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
});
const tasks = [
  { id: "lead1", role: "lead", title: "Lập kế hoạch" },
  { id: "peer1", role: "peer", moduleId: "web", title: "Xây UI" }
] as Task[];
const workflows = [{ id: "wf", title: "Demo" }] as WorkflowRun[];

test("JSON plan và review hiển thị nội dung ngắn gọn thay cho raw JSON", () => {
  const plan = entry(JSON.stringify({ summary: "Demo", tasks: [{ title: "Xây giao diện" }, { title: "Viết test" }] }));
  assert.match(readableDetail(plan), /2 nhiệm vụ/);
  const review = entry(JSON.stringify({ summary: "Review", reviews: [
    { decision: "accept" }, { decision: "rework" }
  ] }));
  assert.match(readableDetail(review), /1 đạt, 1 cần sửa/);
  const peer = entry(JSON.stringify({ summary: "Hoàn thành giao diện", changedFiles: ["src/App.tsx"] }));
  assert.match(readableDetail(peer), /1 tệp/);
});
test("JSON đang stream chưa hoàn chỉnh không làm UI hiện chuỗi JSON rời rạc", () => {
  assert.equal(readableDetail(entry('{"summary": "Đang', "running")), "Agent đang tổng hợp kết quả…");
  assert.equal(shortDetail("abcdef", 3), "abc…");
});
test("phân nhóm và lọc Lead/Peer/Workflow theo task thật", () => {
  const lead = entry("hello");
  const peer = { ...lead, taskId: "peer1" };
  const wf = { ...lead, taskId: "workflow:wf" };
  assert.match(activitySource(lead, tasks, workflows), /^Lead/);
  assert.match(activitySource(peer, tasks, workflows), /^Peer · web/);
  assert.equal(activitySource(wf, tasks, workflows), "Workflow · Demo");
  assert.equal(matchesActivityFilter(lead, tasks, "lead", ""), true);
  assert.equal(matchesActivityFilter(peer, tasks, "lead", ""), false);
  assert.equal(matchesActivityFilter(wf, tasks, "workflow", ""), true);
  assert.equal(matchesActivityFilter(peer, tasks, "all", "lead1"), false);
});
