import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@aacc/contracts";
import { peerMessages, visibleMessages } from "./message-view.js";
const at = "2026-11-03T00:00:00Z";
const messages: Message[] = [
  { id: "1", conversationId: "a", from: "user", to: "lead", text: "Tạo README", createdAt: at },
  { id: "2", conversationId: "a", from: "lead", to: "peer", peerSessionId: "web1",
    text: "Viết README", createdAt: at },
  { id: "3", conversationId: "a", from: "peer", to: "lead", peerSessionId: "web1",
    text: "Đã xong", createdAt: at },
  { id: "4", conversationId: "a", from: "lead", to: "user", text: "Hoàn thành", createdAt: at },
  { id: "5", conversationId: "other", from: "user", to: "lead", text: "Other", createdAt: at }
];
test("Mặc định chỉ hiển thị User ↔ Lead, có thể mở log Lead ↔ Peer", () => {
  assert.deepEqual(visibleMessages(messages, "a").map(m => m.id), ["1", "4"]);
  assert.deepEqual(visibleMessages(messages, "a", true).map(m => m.id), ["1", "2", "3", "4"]);
  assert.deepEqual(peerMessages(messages, "web1").map(m => m.id), ["2", "3"]);
});
