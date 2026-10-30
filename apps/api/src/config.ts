import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceConfig } from "@aacc/contracts";

const defaultFile = fileURLToPath(new URL("../../../config/workspace.local.json", import.meta.url));

function directory(input: unknown, field: string): string {
  if (typeof input !== "string" || !isAbsolute(input)) {
    throw new Error(field + " phải là đường dẫn tuyệt đối");
  }
  const path = realpathSync(input);
  if (!statSync(path).isDirectory()) throw new Error(field + " không phải thư mục");
  return path;
}

export function loadWorkspaceConfig(file = process.env.WORKSPACE_CONFIG ?? defaultFile): WorkspaceConfig {
  const raw = JSON.parse(readFileSync(resolve(file), "utf8")) as Partial<WorkspaceConfig>;
  if (!raw.lead || !Array.isArray(raw.modules)) throw new Error("Config thiếu lead hoặc modules");
  if (typeof raw.lead.instructions !== "string") throw new Error("lead.instructions không hợp lệ");
  const lead = { cwd: directory(raw.lead.cwd, "lead.cwd"), instructions: raw.lead.instructions };
  const reviewer = raw.reviewer === undefined ? undefined : {
    cwd: directory(raw.reviewer.cwd, "reviewer.cwd"),
    instructions: (() => {
      if (typeof raw.reviewer?.instructions !== "string") {
        throw new Error("reviewer.instructions không hợp lệ");
      }
      return raw.reviewer.instructions;
    })()
  };
  const ids = new Set<string>();
  const modules = raw.modules.map((m, index) => {
    if (!m || typeof m.id !== "string" || !/^[a-z0-9_-]+$/.test(m.id) ||
        typeof m.label !== "string" || !m.label.trim() || ids.has(m.id)) {
      throw new Error("Module không hợp lệ tại index " + index);
    }
    ids.add(m.id);
    if (m.testCommand !== undefined &&
        (!Array.isArray(m.testCommand) || !m.testCommand.length || m.testCommand.length > 12 ||
          !m.testCommand.every((part) => typeof part === "string" && part.length > 0 && part.length <= 250))) {
      throw new Error("modules[" + index + "].testCommand phải là argv không rỗng");
    }
    return {
      id: m.id, label: m.label, path: directory(m.path, "modules[" + index + "].path"),
      ...(m.testCommand ? { testCommand: m.testCommand } : {})
    };
  });
  return { lead, ...(reviewer ? { reviewer } : {}), modules };
}
