import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PeerResult, PeerEvidence } from "@aacc/contracts";
import type { TaskStore } from "./store.js";

const exec = promisify(execFile);
const MAX_DIFF = 12000;

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await exec("git", ["-C", cwd, ...args], {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return result.stdout;
  } catch {
    return null;
  }
}

export async function gitBaseline(cwd: string): Promise<string | null> {
  // Chỉ đọc Git, không thao tác với index hay working tree.
  return git(cwd, ["status", "--short", "--untracked-files=normal"]);
}

export async function collectPeerEvidence(
  cwd: string,
  baseline: string | null,
  result: PeerResult,
  store: TaskStore,
  taskId: string
): Promise<PeerEvidence> {
  const [statusAfter, diffStat, rawDiff] = await Promise.all([
    git(cwd, ["status", "--short", "--untracked-files=normal"]),
    git(cwd, ["diff", "--stat", "HEAD", "--"]),
    git(cwd, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--"])
  ]);
  const diff = rawDiff ?? "";
  const fileEvidence = result.changedFiles.map((path) => {
    // Đường dẫn Peer tự báo cáo là untrusted. Không đọc ngoài cwd hoặc theo symlink.
    if (!path || isAbsolute(path)) return { path, exists: false, insideWorkspace: false };
    const absolute = resolve(cwd, path);
    const fromRoot = relative(cwd, absolute);
    if (fromRoot === ".." || fromRoot.startsWith(".." + sep) || isAbsolute(fromRoot)) {
      return { path, exists: false, insideWorkspace: false };
    }
    try {
      const actual = realpathSync(absolute);
      const relativeActual = relative(cwd, actual);
      const insideWorkspace = relativeActual !== ".." &&
        !relativeActual.startsWith(".." + sep) && !isAbsolute(relativeActual);
      return { path, insideWorkspace, exists: insideWorkspace && statSync(actual).isFile() };
    } catch {
      // Deleted/missing file, still report path but don't read it.
      return { path, exists: false, insideWorkspace: true };
    }
  });
  const commands = store.eventsForTask(taskId)
    .filter((event) => event.kind === "item/completed")
    .flatMap((event) => {
      const data = event.data as { item?: { type?: string; command?: string; exitCode?: number } } | null;
      const item = data?.item;
      if (item?.type !== "commandExecution" || typeof item.command !== "string") return [];
      return [{
        command: item.command,
        ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {})
      }];
    });
  return {
    git: {
      supported: baseline !== null && statusAfter !== null,
      statusBefore: baseline ?? "",
      statusAfter: statusAfter ?? "",
      diffStat: diffStat ?? "",
      diffPreview: diff.slice(0, MAX_DIFF),
      truncated: diff.length > MAX_DIFF
    },
    files: fileEvidence,
    commands
  };
}
