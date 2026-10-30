import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./store.js";

test("P2 SQLite persists snapshot and journal; SQLite is authoritative over legacy JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-sqlite-"));
  try {
    const store = new TaskStore(dir);
    store.event("t1", "workflow/planning", { title: "Feature" });
    store.event("t1", "item/commandExecution/outputDelta", { delta: "ignored" });
    const first = store.journal(0, 50);
    assert.equal(first.length, 1);
    assert.equal(first[0].kind, "workflow/planning");
    assert.equal(first[0].seq, 1);
    // Legacy state.json can be stale or corrupted; SQLite must take precedence.
    writeFileSync(join(dir, "state.json"), "{NOT VALID JSON");
    const restarted = new TaskStore(dir);
    assert.equal(restarted.journal().length, 1);
    assert.equal(restarted.events()[0].kind, "workflow/planning");
    assert.equal(restarted.journal(1, 100).length, 0);
    assert.throws(() => restarted.journal(-1), /pagination/);
    const db = new DatabaseSync(join(dir, "state.sqlite"));
    const row = db.prepare("SELECT COUNT(*) AS total FROM event_journal").get()!;
    assert.equal(Number(row.total), 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2 migrates legacy P1 JSON state and journal exactly once", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-sqlite-legacy-"));
  try {
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      tasks: [], workflows: [], approvals: [], events: [{
        id: "ev1", taskId: "test", kind: "workflow/plan", data: { summary: "ok", tasks: [] },
        createdAt: new Date().toISOString()
      }]
    }));
    const store = new TaskStore(dir);
    assert.equal(store.journal().length, 1);
    assert.equal(new TaskStore(dir).journal().length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
