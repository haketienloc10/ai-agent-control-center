import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./store.js";

test("stream delta được gom một entry và không chiếm hết raw journal", () => {
  const directory = mkdtempSync(join(tmpdir(), "aacc-activity-"));
  try {
    const store = new TaskStore(directory);
    for (let i = 0; i < 250; i++) {
      store.event("task1", "item/agentMessage/delta", { itemId: "msg1", delta: "a" });
    }
    store.event("task1", "item/completed", {
      itemId: "msg1", item: { type: "agentMessage", text: "Hoàn thành" }
    });
    assert.equal(store.activities().length, 1);
    assert.equal(store.activities()[0].detail, "Hoàn thành");
    assert.equal(store.events().length, 1);
    const persisted = new TaskStore(directory);
    assert.equal(persisted.activities()[0].detail, "Hoàn thành");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("migrate sự kiện cũ thành timeline, không trộn nội dung các item", () => {
  const directory = mkdtempSync(join(tmpdir(), "aacc-activity-"));
  try {
    writeFileSync(join(directory, "state.json"), JSON.stringify({
      tasks: [], approvals: [], workflows: [],
      events: [
        { id: "a", taskId: "task1", kind: "item/agentMessage/delta", createdAt: "2026-01-01T00:00:00Z", data: { itemId: "m1", delta: "Xin " } },
        { id: "b", taskId: "task1", kind: "item/agentMessage/delta", createdAt: "2026-01-01T00:00:01Z", data: { itemId: "m1", delta: "chào" } },
        { id: "c", taskId: "task1", kind: "turn/completed", createdAt: "2026-01-01T00:00:02Z", data: { turn: { status: "completed" } } }
      ]
    }));
    const store = new TaskStore(directory);
    assert.equal(store.activities().length, 2);
    assert.equal(store.activities()[0].detail, "Xin chào");
    const onDisk = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    assert.equal(onDisk.activities.length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
