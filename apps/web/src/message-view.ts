import type { Message } from "@aacc/contracts";
/** Hide implementation traffic by default; user always sees Lead and system updates. */
export function visibleMessages(messages: Message[], conversationId: string, showRouting = false): Message[] {
  return messages.filter(m => m.conversationId === conversationId &&
    (showRouting || m.from === "user" || m.to === "user"));
}
export function peerMessages(messages: Message[], peerSessionId: string) {
  return messages.filter(m => m.peerSessionId === peerSessionId);
}
