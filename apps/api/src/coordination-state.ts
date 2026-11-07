import { randomUUID } from "node:crypto";
import type { ContextPacket, Delivery, Message, MessageAuthor, Snapshot } from "@aacc/contracts";

export type Data = Omit<Snapshot, "modules">;
export const now = () => new Date().toISOString();
export const text = (value: unknown, label: string, limit = 20000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(label + " phải là chuỗi không rỗng, tối đa " + limit + " ký tự");
  }
  return value.trim();
};
export function message(data: Data, conversationId: string, from: MessageAuthor,
  to: Message["to"], body: string, agentSessionId?: string, contextPacket?: ContextPacket,
  id = randomUUID()): Message {
  const entry: Message = {
    id, conversationId, from, to, text: body,
    ...(agentSessionId ? (data.sessions.some(s => s.id === agentSessionId &&
        s.role === "discovery")
      ? { discoverySessionId: agentSessionId } : { peerSessionId: agentSessionId }) : {}),
    ...(contextPacket ? { contextPacket } : {}),
    createdAt: now()
  };
  data.messages.push(entry);
  return entry;
}

export function deliver(data: Data, conversationId: string, sessionId: string, messageId: string,
  eventMessageIds?: string[]) {
  const entry: Delivery = {
    id: randomUUID(), conversationId, sessionId, messageId,
    ...(eventMessageIds ? { eventMessageIds } : {}),
    generation: data.conversations.find(c => c.id === conversationId)!.generation,
    status: "queued", createdAt: now(), updatedAt: now()
  };
  data.deliveries.push(entry);
  return entry;
}
