import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PeerEvidence, Task, WorkspaceConfig } from "@aacc/contracts";
import { WorktreeManager } from "./worktree-manager.js";
import { ArtifactStore } from "./artifacts.js";

const exec = promisify(execFile);
export class P2Services {
  constructor(
    private readonly config: WorkspaceConfig,
    public readonly worktrees: WorktreeManager,
    public readonly artifacts: ArtifactStore
  ) {}

  async capture(task: Task, evidence: PeerEvidence): Promise<PeerEvidence> {
    if (!task.workflowId || !task.moduleId || !task.executionCwd || !task.worktreeRoot ||
        !task.sourceRoot || !task.sourceModule || task.moduleRelative === undefined || !task.baseHead) {
      return evidence;
    }
    const loc = {
      cwd: task.executionCwd, root: task.worktreeRoot, sourceRoot: task.sourceRoot,
      sourceModule: task.sourceModule, moduleRelative: task.moduleRelative, baseHead: task.baseHead
    };
    const patch = this.worktrees.patch(loc);
    if (patch.length) {
      const descriptor = this.artifacts.add({
        workflowId: task.workflowId, moduleId: task.moduleId, taskId: task.id, kind: "patch"
      }, patch);
      evidence.patchArtifactId = descriptor.id;
      evidence.git.diffPreview = patch.slice(0, 12000);
      evidence.git.truncated = patch.length > 12000;
      evidence.git.supported = true;
    }
    const command = this.config.modules.find(m => m.id === task.moduleId)?.testCommand;
    if (!command?.length) {
      evidence.verifiedTest = { status: "not_configured" };
      return evidence;
    }
    let status: "passed" | "failed" = "passed";
    let exitCode = 0;
    let output = "";
    try {
      const response = await exec(command[0], command.slice(1), {
        cwd: task.executionCwd, timeout: 60000, maxBuffer: 64 * 1024,
        windowsHide: true
      });
      output = (response.stdout + "\n" + response.stderr).slice(0, 6000);
    } catch (error) {
      status = "failed";
      const e = error as Error & { code?: string | number; stdout?: string; stderr?: string };
      exitCode = typeof e.code === "number" ? e.code : -1;
      output = (String(e.stdout ?? "") + "\n" + String(e.stderr ?? "") + "\n" + e.message).slice(0, 6000);
    }
    evidence.verifiedTest = { status, command: command.join(" "), exitCode, output };
    this.artifacts.add({
      workflowId: task.workflowId, moduleId: task.moduleId, taskId: task.id, kind: "test-output"
    }, JSON.stringify(evidence.verifiedTest, null, 2));
    return evidence;
  }
}
