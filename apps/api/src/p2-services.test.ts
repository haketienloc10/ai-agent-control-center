import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerEvidence, WorkspaceConfig } from "@aacc/contracts";
import { createTask } from "./domain.js";
import { WorktreeManager } from "./worktree-manager.js";
import { ArtifactStore } from "./artifacts.js";
import { P2Services } from "./p2-services.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function fixture(command: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "aacc-p2-testcmd-"));
  const moduleDir = join(dir, "repo");
  mkdirSync(moduleDir);
  git(moduleDir, "init", "-q");
  writeFileSync(join(moduleDir, "README.md"), "baseline\n");
  git(moduleDir, "add", ".");
  git(moduleDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
  const config: WorkspaceConfig = {
    lead: { cwd: dir, instructions: "Lead" },
    modules: [{ id: "api", label: "API", path: moduleDir, testCommand: command }]
  };
  const task = createTask({ title: "API", role: "peer", moduleId: "api", prompt: "Make change" }, config);
  task.workflowId = "integration";
  const worktrees = new WorktreeManager(config, join(dir, "data"));
  const artifactStore = new ArtifactStore(join(dir, "data"));
  const location = worktrees.ensure(task);
  Object.assign(task, {
    executionCwd: location.cwd, worktreeRoot: location.root,
    sourceRoot: location.sourceRoot, sourceModule: location.sourceModule,
    moduleRelative: location.moduleRelative, baseHead: location.baseHead
  });
  writeFileSync(join(location.cwd, "new-feature.js"), "export const created = true;\n");
  const evidence: PeerEvidence = {
    git: { supported: true, statusBefore: "", statusAfter: "",
      diffStat: "", diffPreview: "", truncated: false },
    files: [], commands: []
  };
  return { dir, moduleDir, task, worktrees, artifactStore, config, evidence };
}
test("P2 independent runner PASS and patch available with SHA-256", async () => {
  const fixtureData = fixture([process.execPath, "-e", "process.exit(0)"]);
  try {
    const { task, worktrees, artifactStore, config, evidence, moduleDir } = fixtureData;
    const p2 = new P2Services(config, worktrees, artifactStore);
    const result = await p2.capture(task, evidence);
    assert.equal(result.verifiedTest?.status, "passed");
    assert.equal(result.verifiedTest?.exitCode, 0);
    assert.ok(result.patchArtifactId);
    assert.match(artifactStore.get(result.patchArtifactId!).content.toString(), /new-feature.js/);
    assert.equal(artifactStore.list(task.workflowId).length, 2);
    assert.equal(git(moduleDir, "status", "--porcelain"), "");
  } finally { rmSync(fixtureData.dir, { recursive: true, force: true }); }
});

test("P2 independent runner FAIL cannot be reported as PASS", async () => {
  const fixtureData = fixture([process.execPath, "-e", "process.exit(3)"]);
  try {
    const result = await new P2Services(fixtureData.config, fixtureData.worktrees, fixtureData.artifactStore)
      .capture(fixtureData.task, fixtureData.evidence);
    assert.equal(result.verifiedTest?.status, "failed");
    assert.equal(result.verifiedTest?.exitCode, 3);
  } finally { rmSync(fixtureData.dir, { recursive: true, force: true }); }
});
