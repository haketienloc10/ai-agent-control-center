import type { CodexModelOption } from "@aacc/contracts";
import type { CodexClient } from "./codex-client.js";

interface ModelEntry {
  id?: unknown; model?: unknown; displayName?: unknown; hidden?: unknown;
  defaultReasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
}
interface ModelListResponse {
  data?: ModelEntry[]; nextCursor?: string | null;
}
/** Ask the running Codex installation; never hardcode account-specific model names. */
export async function modelCatalog(client: Pick<CodexClient, "start" | "request">): Promise<CodexModelOption[]> {
  await client.start();
  const result = new Map<string, CodexModelOption>();
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const response = await client.request<ModelListResponse>("model/list", {
      limit: 100, includeHidden: false,
      ...(cursor ? { cursor } : {})
    });
    if (!response || !Array.isArray(response.data)) {
      throw new Error("Codex model/list returned invalid data");
    }
    for (const entry of response.data) {
      if (entry.hidden === true) continue;
      const id = typeof entry.model === "string" && entry.model
        ? entry.model : typeof entry.id === "string" ? entry.id : "";
      if (!id) continue;
      const efforts = Array.isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts.flatMap(e => {
          if (typeof e === "string") return [e];
          if (e && typeof e === "object" &&
            typeof (e as { reasoningEffort?: unknown }).reasoningEffort === "string") {
            return [(e as { reasoningEffort: string }).reasoningEffort];
          }
          return [];
        }) : [];
      result.set(id, {
        id, displayName: typeof entry.displayName === "string" ? entry.displayName : id,
        supportedReasoningEfforts: [...new Set(efforts)],
        ...(typeof entry.defaultReasoningEffort === "string"
          ? { defaultReasoningEffort: entry.defaultReasoningEffort } : {})
      });
    }
    if (!response.nextCursor || response.nextCursor === cursor) break;
    cursor = response.nextCursor;
  }
  return [...result.values()];
}
