import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask } from "./domain.js";
import { TaskStore } from "./store.js";

test("State persisted; running thành interrupted và approval hết hạn sau restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "aacc-test-"));
  try {
    const store = new TaskStore(directory);
    const task = createTask(
      { title: "Run", prompt: "Inspect", role: "lead" },
      { lead: { cwd: directory, instructions: "" }, modules: [] }
    );
    store.add(task);
    store.update(task.id, {}, "starting");
    store.update(task.id, {}, "running");
    store.addApproval({
      taskId: task.id,
      requestId: 42,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t1" }
    });
    const afterRestart = new TaskStore(directory);
    assert.equal(afterRestart.get(task.id)?.status, "interrupted");
    assert.equal(afterRestart.approvals()[0]?.status, "expired");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
