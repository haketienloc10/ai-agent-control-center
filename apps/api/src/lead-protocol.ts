import type { LeadCommand, LeadResponse } from "@aacc/contracts";

/** Only the message-routing envelope is machine-readable; work quality is Lead-owned. */
export class LeadProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadProtocolError";
  }
}
function actionIntent(value: string): boolean {
  // Include escaped and double-encoded JSON: a missing routing action must never
  // silently downgrade to a plain message, even when JSON.parse fails.
  return /\b(?:spawn_peer|send_peer)\b/.test(value) ||
    (/\bcommands\b/.test(value) && /[{}\[\]]/.test(value));
}
function parseObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}/i)?.[1];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  const embedded = first >= 0 && last > first ? trimmed.slice(first, last + 1) : undefined;
  for (const source of [trimmed, fenced, embedded]) {
    if (!source) continue;
    try {
      let parsed: unknown = JSON.parse(source);
      // Some models serialize a complete JSON envelope as a JSON string.
      for (let depth = 0; depth < 2 && typeof parsed === "string" &&
        parsed.trim().startsWith("{"); depth++) {
        parsed = JSON.parse(parsed);
      }
      return parsed;
    } catch { /* Try another transport representation before reporting a syntax error. */ }
  }
  if (actionIntent(raw)) {
    throw new LeadProtocolError("Lead đã đưa ra action nhưng JSON không hợp lệ. " +
      "Không có lệnh nào được dispatch; cần gửi lại JSON envelope hợp lệ.");
  }
  return raw;
}
export function parseLeadResponse(raw: string): LeadResponse {
  const value = parseObject(raw);
  if (typeof value === "string") return { reply: value, commands: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reply: raw, commands: [] };
  }
  const data = value as Record<string, unknown>;
  const reply = typeof data.reply === "string" ? data.reply.slice(0, 20000) : undefined;
  if ("commands" in data && !Array.isArray(data.commands)) {
    throw new LeadProtocolError("Lead.commands phải là mảng action.");
  }
  const commands: LeadCommand[] = [];
  if (Array.isArray(data.commands)) {
    for (const input of data.commands.slice(0, 32)) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new LeadProtocolError("Lead.commands chứa action không phải object.");
      }
      const a = input as Record<string, unknown>;
      if (a.type === "spawn_peer") {
        if (typeof a.moduleId !== "string" || !a.moduleId.trim() ||
          typeof a.message !== "string" || !a.message.trim()) {
          throw new LeadProtocolError("spawn_peer cần moduleId và message hợp lệ.");
        }
        commands.push({
          type: "spawn_peer", moduleId: a.moduleId, message: a.message.slice(0, 20000),
          ...(typeof a.label === "string" ? { label: a.label.slice(0, 100) } : {})
        });
      } else if (a.type === "send_peer") {
        if (typeof a.sessionId !== "string" || !a.sessionId.trim() ||
          typeof a.message !== "string" || !a.message.trim()) {
          throw new LeadProtocolError("send_peer cần sessionId và message hợp lệ.");
        }
        commands.push({
          type: "send_peer", sessionId: a.sessionId, message: a.message.slice(0, 20000)
        });
      } else if (a.type === "finish") {
        commands.push({
          type: "finish",
          ...(typeof a.summary === "string" ? { summary: a.summary.slice(0, 20000) } : {})
        });
      }
      // Unknown actions are ignored; app never executes an unregistered action.
    }
    if (data.commands.length && !commands.length) {
      throw new LeadProtocolError("Lead.commands không chứa action nào có thể thực thi.");
    }
  }
  if (!reply && !commands.length) return { reply: raw, commands: [] };
  return { ...(reply ? { reply } : {}), commands };
}
