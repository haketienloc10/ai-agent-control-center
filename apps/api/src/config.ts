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
  if (Object.keys(raw.lead).some(key => key !== "cwd")) {
    throw new Error("lead chỉ nhận cwd; quy tắc dự án tùy chỉnh thuộc AGENTS.md");
  }
  const lead = { cwd: directory(raw.lead.cwd, "lead.cwd") };
  const ids = new Set<string>();
  const modules = raw.modules.map((module, index) => {
    if (!module || typeof module.id !== "string" || !/^[a-z0-9_-]+$/.test(module.id) ||
        ids.has(module.id) || typeof module.label !== "string" || !module.label.trim()) {
      throw new Error("Module không hợp lệ tại index " + index);
    }
    ids.add(module.id);
    return { id: module.id, label: module.label, path: directory(module.path, "modules[" + index + "].path") };
  });
  let discovery: WorkspaceConfig["discovery"];
  if (raw.discovery) {
    if (Object.keys(raw.discovery).some(key => !["cwd", "enabled"].includes(key))) {
      throw new Error("discovery chỉ nhận cwd và enabled; model/effort thuộc App Settings");
    }
    const cwd = directory(raw.discovery.cwd, "discovery.cwd");
    if (cwd === lead.cwd || modules.some(module => module.path === cwd)) {
      throw new Error("discovery.cwd phải là thư mục riêng, khác Lead và các module");
    }
    if (raw.discovery.enabled !== undefined && typeof raw.discovery.enabled !== "boolean") {
      throw new Error("discovery.enabled phải là boolean");
    }
    discovery = { cwd, enabled: raw.discovery.enabled ?? true };
  }
  return { lead, ...(discovery ? { discovery } : {}), modules };
}
