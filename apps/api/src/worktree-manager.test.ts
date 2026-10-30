import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask } from "./domain.js";
import { WorktreeManager } from "./worktree-manager.js";
import type { WorkspaceConfig } from "@aacc/contracts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("P2: detached worktrees per workflow/module, original source stays untouched; patch includes untracked", () => {
  const root = mkdtempSync(join(tmpdir(), "aacc-p2-git-"));
  try {
    const source = join(root, "source");
    mkdirSync(source);
    git(source, "init", "-q");
    for (const id of ["api", "web"]) {
      mkdirSync(join(source, id));
      writeFileSync(join(source, id, "README.md"), "original\n");
    }
    git(source, "add", ".");
    git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init");
    const config: WorkspaceConfig = {
      lead: { cwd: root, instructions: "Lead" },
      modules: ["api", "web"].map(id => ({ id, label: id, path: join(source, id) }))
    };
    const manager = new WorktreeManager(config, join(root, "data"));
    const a = createTask({ role: "peer", title: "api", prompt: "write", moduleId: "api" }, config);
    a.workflowId = "workflow-a";
    const b = createTask({ role: "peer", title: "api", prompt: "write", moduleId: "api" }, config);
    b.workflowId = "workflow-b";
    const a1 = manager.ensure(a);
    const a2 = manager.ensure(a);
    const b1 = manager.ensure(b);
    assert.equal(a1.cwd, a2.cwd);
    assert.notEqual(a1.root, b1.root);
    assert.equal(a1.moduleRelative, "api");
    writeFileSync(join(a1.cwd, "created.ts"), "export const x = 1;\n");
    const patch = manager.patch(a1);
    assert.match(patch, /created.ts/);
    assert.match(patch, /export const x = 1/);
    assert.equal(git(source, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(source, "api", "README.md"), "utf8"), "original\n");
    assert.equal(git(b1.root, "status", "--porcelain"), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P2: fail closed on dirty source or non-git folder", () => {
  const root = mkdtempSync(join(tmpdir(), "aacc-p2-dirty-"));
  try {
    git(root, "init", "-q");
    writeFileSync(join(root, "readme.txt"), "base\n");
    git(root, "add", ".");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init");
    const config: WorkspaceConfig = {
      lead: { cwd: root, instructions: "Lead" },
      modules: [{ id: "src", label: "Source", path: root }]
    };
    const manager = new WorktreeManager(config, join(tmpdir(), "aacc-wt-" + Math.random().toString(36).slice(2)));
    const task = createTask({ role: "peer", title: "edit", prompt: "edit", moduleId: "src" }, config);
    writeFileSync(join(root, "untracked.txt"), "dirty");
    assert.throws(() => manager.ensure(task), /uncommitted\/untracked/);
    rmSync(join(root, "untracked.txt"));
    assert.ok(manager.ensure(task).cwd);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
