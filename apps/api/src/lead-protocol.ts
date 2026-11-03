import type { LeadCommand, LeadResponse } from "@aacc/contracts";

/** JSON is a transport envelope for agent actions, NOT a quality/review schema. */
export function parseLeadResponse(raw: string): LeadResponse {
  const clean = raw.trim().replace(/^\x60\x60\x60(?:json)?\s*\n/i, "").replace(/\n\x60\x60\x60$/, "").trim();
  let value: unknown;
  try { value = JSON.parse(clean); }
  catch {
    // A normal Lead answer is always allowed; no mechanical workflow rejection.
    return { reply: raw, commands: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reply: raw, commands: [] };
  }
  const data = value as Record<string, unknown>;
  const reply = typeof data.reply === "string" ? data.reply.slice(0, 20000) : undefined;
  const commands: LeadCommand[] = [];
  if (Array.isArray(data.commands)) {
    for (const input of data.commands.slice(0, 32)) {
      if (!input || typeof input !== "object" || Array.isArray(input)) continue;
      const a = input as Record<string, unknown>;
      if (a.type === "spawn_peer" && typeof a.moduleId === "string" &&
        typeof a.message === "string" && a.message.trim()) {
        commands.push({
          type: "spawn_peer", moduleId: a.moduleId, message: a.message.slice(0, 20000),
          ...(typeof a.label === "string" ? { label: a.label.slice(0, 100) } : {})
        });
      } else if (a.type === "send_peer" && typeof a.sessionId === "string" &&
        typeof a.message === "string" && a.message.trim()) {
        commands.push({ type: "send_peer", sessionId: a.sessionId, message: a.message.slice(0, 20000) });
      } else if (a.type === "finish") {
        commands.push({
          type: "finish",
          ...(typeof a.summary === "string" ? { summary: a.summary.slice(0, 20000) } : {})
        });
      }
    }
  }
  if (!reply && !commands.length) return { reply: raw, commands: [] };
  return { ...(reply ? { reply } : {}), commands };
}
