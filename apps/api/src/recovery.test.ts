import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@aacc/contracts";
import { createTask } from "./domain.js";
import { TaskStore } from "./store.js";
import { RecoveryManager } from "./recovery.js";
import type { SessionManager } from "./session-manager.js";
import type { CodexClient } from "./codex-client.js";

test("P2 restart reconciliation never replays turn; explicit followup reuses thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-recovery-"));
  try {
    const config: WorkspaceConfig = { lead: { cwd: dir, instructions: "Lead" }, modules: [] };
    let store = new TaskStore(dir);
    const task = store.add(createTask({ role: "lead", title: "Plan", prompt: "Original", }, config));
    store.update(task.id, {}, "starting");
    store.update(task.id, { threadId: "thread1", turnId: "turn1" }, "running");
    store = new TaskStore(dir);
    assert.equal(store.get(task.id)?.status, "interrupted");
    const requests: string[] = [];
    const codex = {
      async start() { /* connect */ },
      async request(method: string) {
        requests.push(method);
        if (method === "thread/read") return { thread: { status: { type: "idle" } } };
        if (method === "thread/turns/list") return { turns: [{ id: "turn1", status: "completed" }] };
        throw new Error("Unsupported mock request");
      }
    } as unknown as CodexClient;
    const started: string[] = [];
    const sessions = { start(id: string) { started.push(id); } } as unknown as SessionManager;
    const recovery = new RecoveryManager(config, store, codex, sessions);
    assert.equal(store.get(task.id)?.reconciliation, undefined);
    await recovery.reconcile(task.id);
    assert.equal(store.get(task.id)?.reconciliation?.status, "completed");
    assert.equal(store.get(task.id)?.status, "interrupted");
    assert.deepEqual(requests, ["thread/read", "thread/turns/list"]);
    const continued = await recovery.continueTask(task.id, "Check existing work, do not repeat");
    assert.equal(continued.threadId, "thread1");
    assert.equal(continued.status, "queued");
    assert.equal(started.length, 1);
    assert.notEqual(continued.id, task.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
