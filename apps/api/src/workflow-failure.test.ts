import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun, WorkspaceConfig } from "@aacc/contracts";
import { WorkflowEngine } from "./workflow-engine.js";
import { WorktreeManager } from "./worktree-manager.js";
import { TaskStore } from "./store.js";
import { createTask } from "./domain.js";
import type { AgentTaskExecutor } from "./session-manager.js";

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
function repo(root: string, name: string) {
  const path = join(root, name);
  mkdirSync(path);
  git(path, "init", "-q");
  writeFileSync(join(path, "README.md"), "base\n");
  git(path, "add", ".");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init");
  return path;
}
async function until(store: TaskStore, id: string, expected: string): Promise<WorkflowRun> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      store.off("change", check); reject(new Error("Timed out waiting for " + expected));
    }, 7500);
    function check() {
      const result = store.getWorkflow(id);
      if (result?.status === expected) {
        clearTimeout(timeout); store.off("change", check); resolve(result);
      }
    }
    store.on("change", check);
    check();
  });
}

test("P3 Git dirty: prepare fails before thread start, failing Task not queued, downstream skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "aacc-dirty-workflow-"));
  let store: TaskStore | undefined;
  try {
    const api = repo(root, "api");
    const web = repo(root, "web");
    writeFileSync(join(web, "untracked.txt"), "Do not delete me\n");
    const config: WorkspaceConfig = {
      lead: { cwd: root, instructions: "Lead" },
      modules: [{ id: "api", label: "API", path: api }, { id: "web", label: "Web", path: web }]
    };
    store = new TaskStore(join(root, "data"));
    const worktrees = new WorktreeManager(config, join(root, "data"));
    const recorder = { starts: [] as string[], prepares: [] as string[] };
    const executor: AgentTaskExecutor = {
      async prepare(taskId) {
        const t = store!.get(taskId)!;
        recorder.prepares.push(t.moduleId ?? "");
        if (t.role !== "peer") return config.lead.cwd;
        const loc = worktrees.ensure(t);
        store!.update(taskId, { executionCwd: loc.cwd });
        return loc.cwd;
      },
      async runAndWait(taskId) {
        const task = store!.get(taskId)!;
        recorder.starts.push(task.title);
        store!.update(taskId, {}, "starting");
        store!.update(taskId, {}, "running");
        let output: unknown;
        if (task.title.startsWith("Lead: lập kế hoạch")) {
          output = {
            summary: "Two module feature", acceptanceCriteria: [{
              id: "ac1", description: "Both modules compile", verification: "Run tests"
            }], integrationContracts: [], orderingOnlyDependencies: [],
            tasks: [
              { id: "api1", title: "Implement API", moduleId: "api",
                instructions: "Build API", dependsOn: [] },
              { id: "web1", title: "Implement Web", moduleId: "web",
                instructions: "Build UI", dependsOn: [] },
              { id: "web2", title: "Web follow-up", moduleId: "web",
                instructions: "Verify UI", dependsOn: ["web1"] }
            ]
          };
        } else if (task.role === "peer") {
          output = { summary: "Mock implementation", changedFiles: [],
            tests: [{ status: "not_run", details: "Fake runner" }], risks: [] };
        } else {
          throw new Error("Review should not run after dirty Git preflight");
        }
        const text = JSON.stringify(output);
        store!.update(taskId, { output: text }, "completed");
        return text;
      }
    };
    const engine = new WorkflowEngine(config, store, executor);
    const created = engine.create({ title: "Mini Task Board", request: "API plus Web" });
    const failed = await until(store, created.id, "failed");
    assert.equal(failed.failureHint?.code, "dirty_source");
    assert.equal(failed.failureHint?.path, web);
    assert.match(failed.error ?? "", /uncommitted\/untracked/);
    assert.deepEqual(failed.peers.map(p => [p.id, p.status]), [
      ["api1", "skipped"], ["web1", "failed"], ["web2", "skipped"]
    ]);
    const failing = store.list().find(t => t.role === "peer" && t.moduleId === "web");
    assert.equal(failing?.status, "failed");
    assert.match(failing?.error ?? "", /uncommitted\/untracked/);
    assert.ok(failing?.finishedAt);
    assert.equal(recorder.starts.filter(name => name.startsWith("Implement Web")).length, 0,
      "Failed preflight must not start a Codex Thread");
    assert.ok(store.list().filter(t => t.workflowId === created.id).every(t => t.status !== "queued"));
    const notice = store.notifications().find(n => n.kind === "workflow_failed");
    assert.match(notice?.message ?? "", /stash -u/);
    assert.equal(existsSync(join(web, "untracked.txt")), true);
    assert.match(git(web, "status", "--short"), /untracked.txt/);
    assert.throws(() => engine.decide(created.id, "approve"));
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("P3 legacy terminal workflow queued Task reconciled on restart without execution", () => {
  const root = mkdtempSync(join(tmpdir(), "aacc-terminal-orphan-"));
  let store: TaskStore | undefined;
  try {
    store = new TaskStore(root);
    const now = new Date().toISOString();
    const wf: WorkflowRun = {
      id: "w-legacy", title: "Legacy", request: "Old job", status: "failed",
      peers: [
        { id: "web1", title: "Web", moduleId: "web",
          instructions: "Write", dependsOn: [], status: "running", attempts: [] },
        { id: "api1", title: "API", moduleId: "api",
          instructions: "Build", dependsOn: [], status: "pending", attempts: [] }
      ],
      leadTaskIds: [], reviewCount: 0, maxReworks: 2,
      createdAt: now, updatedAt: now,
      error: "Source repository has uncommitted/untracked files; commit or clean before P2 isolation: /tmp/old-web"
    };
    store.addWorkflow(wf);
    const task = createTask({ title: "Queued orphan", role: "lead", prompt: "Do not run" },
      { lead: { cwd: root, instructions: "" }, modules: [] });
    task.workflowId = wf.id;
    store.add(task);
    assert.equal(store.get(task.id)?.status, "queued");
    store.close();
    store = new TaskStore(root);
    assert.equal(store.get(task.id)?.status, "cancelled");
    assert.equal(store.getWorkflow(wf.id)?.status, "failed");
    assert.equal(store.getWorkflow(wf.id)?.failureHint?.path, "/tmp/old-web");
    assert.deepEqual(store.getWorkflow(wf.id)?.peers.map(p => p.status), ["failed", "skipped"]);
    assert.equal(store.sessions({ status: "cancelled" }).items[0]?.id, task.id);
    store.close();
    store = new TaskStore(root);
    assert.equal(store.get(task.id)?.status, "cancelled");
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});
