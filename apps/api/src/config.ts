import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceConfig } from "@aacc/contracts";

const defaultFile = fileURLToPath(new URL("../../../config/workspace.local.json", import.meta.url));
function directory(input: unknown, field: string): string {
  if (typeof input !== "string" || !isAbsolute(input)) throw new Error(field + " phải là đường dẫn tuyệt đối");
  const path = realpathSync(input);
  if (!statSync(path).isDirectory()) throw new Error(field + " không phải thư mục");
  return path;
}
export function loadWorkspaceConfig(file = process.env.WORKSPACE_CONFIG ?? defaultFile): WorkspaceConfig {
  const raw = JSON.parse(readFileSync(resolve(file), "utf8")) as Partial<WorkspaceConfig>;
  if (!raw.lead || !Array.isArray(raw.modules)) throw new Error("Thiếu lead hoặc modules");
  const lead = {
    cwd: directory(raw.lead.cwd, "lead.cwd"),
    instructions: typeof raw.lead.instructions === "string" ? raw.lead.instructions : ""
  };
  const ids = new Set<string>();
  const modules = raw.modules.map((module, index) => {
    if (!module || typeof module.id !== "string" || !/^[a-z0-9_-]+$/.test(module.id) ||
        ids.has(module.id) || typeof module.label !== "string" || !module.label.trim()) {
      throw new Error("Module không hợp lệ tại index " + index);
    }
    ids.add(module.id);
    return { id: module.id, label: module.label, path: directory(module.path, "modules[" + index + "].path") };
  });
  return { lead, modules };
}
