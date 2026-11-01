import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SingleInstanceLock } from "./single-instance.js";

test("Single-instance lock refuses second backend and can release", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-lock-"));
  try {
    const first = new SingleInstanceLock(dir);
    assert.throws(() => new SingleInstanceLock(dir), /already running/);
    first.release();
    const next = new SingleInstanceLock(dir);
    next.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
