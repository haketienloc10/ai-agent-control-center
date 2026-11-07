import type { AppSettings, ModelSelection } from "@aacc/contracts";

/** Kiểm tra giá trị transport; Codex quyết định model có hỗ trợ lựa chọn hay không. */
export function normalizeSelection(value: unknown): ModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model selection phải là object");
  }
  const input = value as Record<string, unknown>;
  const selection: ModelSelection = {};
  for (const key of ["model", "effort"] as const) {
    const item = input[key];
    if (item === undefined || item === null || item === "") continue;
    const limit = key === "model" ? 128 : 32;
    if (typeof item !== "string" || item.length > limit ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._+:/-]*$/.test(item)) {
      throw new Error(key + " không hợp lệ");
    }
    selection[key] = item;
  }
  return selection;
}
export function normalizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("App Settings phải là object");
  }
  const input = value as Record<string, unknown>;
  return {
    lead: normalizeSelection(input.lead),
    peer: normalizeSelection(input.peer),
    discovery: normalizeSelection(input.discovery ?? {})
  };
}
