import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts.js";

test("P2 artifacts persist content with sha256 and reject arbitrary paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-artifacts-"));
  try {
    const store = new ArtifactStore(dir);
    const descriptor = store.add({ workflowId: "wf", moduleId: "api", kind: "patch" },
      "diff --git a/a b/a\n+example");
    assert.equal(store.list("wf").length, 1);
    assert.equal(store.get(descriptor.id).content.toString("utf8"), "diff --git a/a b/a\n+example");
    assert.equal(new ArtifactStore(dir).get(descriptor.id).descriptor.sha256, descriptor.sha256);
    assert.throws(() => store.get("../state.json"), /Invalid artifact ID/);
    assert.throws(() => store.get("00000000-0000-0000-0000-000000000000"), /not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
