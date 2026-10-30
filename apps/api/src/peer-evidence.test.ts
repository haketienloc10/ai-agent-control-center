import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./store.js";
import { collectPeerEvidence, gitBaseline } from "./peer-evidence.js";

test("PeerEvidence đọc Git diff, tool events và không theo path traversal/symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "aacc-evidence-"));
  const repo = join(root, "module");
  mkdirSync(repo);
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "before\n");
    git("add", "a.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "initial");
    const before = await gitBaseline(repo);
    assert.equal(before, "");
    writeFileSync(join(repo, "a.txt"), "after\n");
    // Git diff HEAD does not show untracked files, but Lead still needs their contents.
    writeFileSync(join(repo, "new-page.html"), "<h1>Mini Task Board</h1>");
    writeFileSync(join(root, "secret"), "no-access");
    symlinkSync(join(root, "secret"), join(repo, "escape"));
    const store = new TaskStore(join(root, "data"));
    store.event("task1", "item/completed", {
      item: { type: "commandExecution", command: "npm test", exitCode: 0 }
    });
    const evidence = await collectPeerEvidence(repo, before, {
      summary: "Done",
      changedFiles: ["a.txt", "new-page.html", "../secret", "escape"],
      tests: [{ command: "npm test", status: "passed" }],
      risks: []
    }, store, "task1");
    assert.equal(evidence.git.supported, true);
    assert.match(evidence.git.diffPreview, /after/);
    assert.equal(evidence.files[0].exists, true);
    assert.equal(evidence.files[0].contentPreview, "after\n");
    assert.equal(evidence.files[1].contentPreview, "<h1>Mini Task Board</h1>");
    assert.doesNotMatch(evidence.git.diffPreview, /new-page.html/);
    assert.equal(evidence.files[2].insideWorkspace, false);
    assert.equal(evidence.files[3].insideWorkspace, false);
    assert.equal(evidence.commands[0].exitCode, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PeerEvidence giới hạn preview, không đọc file binary", async () => {
  const root = mkdtempSync(join(tmpdir(), "aacc-preview-"));
  try {
    writeFileSync(join(root, "large.txt"), "x".repeat(8000));
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 5, 6]));
    const store = new TaskStore(join(root, "data"));
    const evidence = await collectPeerEvidence(root, null, {
      summary: "Done", changedFiles: ["large.txt", "binary.dat"],
      tests: [{ status: "not_run" }], risks: []
    }, store, "task1");
    assert.equal(evidence.files[0].contentPreview?.length, 2400);
    assert.equal(evidence.files[0].truncated, true);
    assert.equal(evidence.files[1].contentPreview, undefined);
    assert.match(evidence.files[1].previewNote ?? "", /nhị phân/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
