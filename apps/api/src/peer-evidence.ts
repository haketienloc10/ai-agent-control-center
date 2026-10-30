import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PeerResult, PeerEvidence } from "@aacc/contracts";
import type { TaskStore } from "./store.js";

const exec = promisify(execFile);
const MAX_DIFF = 12000;
// Previews are bounded so Lead prompts cannot grow indefinitely.
const MAX_FILES_PREVIEW = 5;
const MAX_BYTES_PER_FILE = 2400;
const MAX_BYTES_TOTAL = 6400;

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
  let previewBudget = MAX_BYTES_TOTAL;
  const fileEvidence = result.changedFiles.map((path, index) => {
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
      const file = insideWorkspace ? statSync(actual) : undefined;
      const exists = !!file?.isFile();
      const base = { path, insideWorkspace, exists };
      if (!file?.isFile()) return base;
      if (index >= MAX_FILES_PREVIEW || previewBudget <= 0) {
        return { ...base, previewNote: "File chưa được đưa vào bản xem trước do giới hạn dung lượng." };
      }
      const size = Math.min(file.size, MAX_BYTES_PER_FILE, previewBudget);
      const buf = Buffer.alloc(size);
      const fd = openSync(actual, "r");
      let bytesRead: number;
      try {
        bytesRead = readSync(fd, buf, 0, size, 0);
      } finally {
        closeSync(fd);
      }
      const content = buf.subarray(0, bytesRead);
      if (content.includes(0)) return { ...base, previewNote: "File nhị phân: không hiển thị nội dung." };
      previewBudget -= bytesRead;
      return {
        ...base,
        contentPreview: content.toString("utf8"),
        truncated: file.size > bytesRead
      };
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
