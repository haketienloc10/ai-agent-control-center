import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Task, WorkspaceConfig } from "@aacc/contracts";

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  }).trimEnd();
}
function gitRoot(path: string): string {
  try { return realpathSync(git(path, "rev-parse", "--show-toplevel")); }
  catch { throw new Error("P2 requires a Git repository with at least one commit: " + path); }
}

export interface IsolatedLocation {
  cwd: string;
  root: string;
  sourceRoot: string;
  sourceModule: string;
  moduleRelative: string;
  baseHead: string;
}

/**
 * Source repo is read-only for Agent tasks; each workflow+module receives a detached worktree.
 * This isolates Git working trees, NOT OS filesystem permissions while YOLO mode is enabled.
 */
export class WorktreeManager {
  private readonly root: string;
  constructor(private readonly config: WorkspaceConfig, dataDir: string) {
    this.root = resolve(dataDir, "worktrees");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  ensure(task: Task): IsolatedLocation {
    if (task.role !== "peer" || !task.moduleId) throw new Error("Only Peer tasks need worktrees");
    const module = this.config.modules.find(m => m.id === task.moduleId);
    if (!module) throw new Error("Unknown module: " + task.moduleId);
    const sourceModule = realpathSync(module.path);
    const sourceRoot = gitRoot(sourceModule);
    const moduleRelative = relative(sourceRoot, sourceModule);
    if (!within(sourceRoot, sourceModule)) throw new Error("Module path escapes source Git repository");
    const scope = task.workflowId || "task-" + task.id;
    if (!/^[0-9a-zA-Z_-]+$/.test(scope) || !/^[0-9a-z_-]+$/.test(module.id)) {
      throw new Error("Invalid worktree key");
    }
    const target = join(this.root, scope, module.id);
    if (existsSync(target)) {
      const actual = realpathSync(target);
      if (!within(this.root, actual) || gitRoot(actual) !== actual) {
        throw new Error("Existing worktree path is invalid: " + target);
      }
      const parent = git(actual, "rev-parse", "--git-common-dir");
      const expected = git(sourceRoot, "rev-parse", "--git-common-dir");
      const resolved = (cwd: string, v: string) => realpathSync(resolve(cwd, v));
      if (resolved(actual, parent) !== resolved(sourceRoot, expected)) {
        throw new Error("Existing worktree belongs to another repository");
      }
    } else {
      // Fail closed: ignoring dirty original code could silently lose user's local changes.
      if (git(sourceRoot, "status", "--porcelain", "--untracked-files=all").trim()) {
        throw new Error("Source repository has uncommitted/untracked files; commit or clean before P2 isolation: " + sourceRoot);
      }
      const head = git(sourceRoot, "rev-parse", "--verify", "HEAD");
      mkdirSync(join(this.root, scope), { recursive: true, mode: 0o700 });
      try { git(sourceRoot, "worktree", "add", "--detach", target, head); }
      catch (error) {
        if (existsSync(target)) rmSync(target, { force: true, recursive: true });
        throw error;
      }
    }
    const root = realpathSync(target);
    const cwd = resolve(root, moduleRelative);
    if (!within(root, cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error("Module subfolder is missing in worktree; commit it before use: " + moduleRelative);
    }
    return { cwd, root, sourceRoot, sourceModule, moduleRelative, baseHead: git(root, "rev-parse", "HEAD") };
  }

  /** Export a patch but NEVER commit, merge, or modify the original working tree. */
  patch(location: IsolatedLocation): string {
    // Only stage inside the isolated worktree. Do not add tracked changes outside module.
    git(location.root, "add", "-A", "--", location.moduleRelative || ".");
    const allChanges = git(location.root, "status", "--porcelain", "--untracked-files=all");
    if (location.moduleRelative && allChanges.split("\n").filter(Boolean).some(line => {
      const path = line.slice(3).replace(/^"/, "").replace(/"$/, "");
      return !(path === location.moduleRelative || path.startsWith(location.moduleRelative + "/"));
    })) {
      throw new Error("Worktree contains changes outside module boundary; patch not exported");
    }
    return execFileSync("git", ["-C", location.root, "diff", "--cached", "--binary", "HEAD", "--",
      location.moduleRelative || "."], { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  }
}
