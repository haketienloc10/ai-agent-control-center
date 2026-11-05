import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot, Conversation, AgentSession, Delivery, Message } from "@aacc/contracts";
import { conversationStatus, sessionStatus, latestDelivery, recentActivity } from "./selectors.js";

const at = "2026-11-05T07:00:00.000Z";
const c: Conversation = { id: "c", title: "Todo", status: "active", leadSessionId: "lead",
  generation: 0, createdAt: at, updatedAt: at };
const lead: AgentSession = { id: "lead", conversationId: "c", role: "lead", label: "Lead",
  status: "idle", createdAt: at, updatedAt: at };
const peer: AgentSession = { id: "web", conversationId: "c", role: "peer",
  label: "Todo Web", moduleId: "web", status: "idle", createdAt: at, updatedAt: at };
function fixture(): Snapshot {
  return { conversations: [{ ...c }], sessions: [{ ...lead }, { ...peer }],
    modules: [], messages: [], deliveries: [], settings: { lead: {}, peer: {} } };
}
const delivery = (status: Delivery["status"]): Delivery => ({
  id: status, conversationId: "c", sessionId: "web", messageId: "msg", generation: 0,
  status, createdAt: at, updatedAt: at
});

test("Conversation badges distinguish active, waiting, finished and interrupted without a fake approval state", () => {
  const data = fixture();
  assert.equal(conversationStatus(data, c).label, "Chờ sự kiện");
  data.sessions[1].status = "running";
  assert.equal(conversationStatus(data, c).label, "Đang chờ Peer");
  data.sessions[1].status = "idle";
  data.deliveries.push(delivery("queued"));
  assert.equal(conversationStatus(data, c).label, "Đang xếp hàng");
  data.sessions[0].status = "running";
  assert.equal(conversationStatus(data, c).label, "Lead đang xử lý");
  data.sessions[0].status = "idle";
  data.sessions[1].status = "interrupted";
  assert.equal(conversationStatus(data, c).tone, "error");
  assert.equal(sessionStatus(data.sessions[1]).label, "Bị gián đoạn");
  assert.equal(conversationStatus(data, { ...c, status: "finished" }).label, "Đã kết thúc");
});

test("Delivery completion is not treated as Peer session completion", () => {
  const data = fixture();
  data.deliveries.push(delivery("completed"));
  assert.equal(latestDelivery(data, "web")?.status, "completed");
  assert.equal(sessionStatus(data.sessions[1]).label, "Idle");
  assert.equal(latestDelivery(data, "unknown"), undefined);
});

test("Activity list uses actual persisted messages, scoped to selected task", () => {
  const data = fixture();
  const messages: Message[] = [
    { id: "a", conversationId: "c", from: "user", to: "lead", text: "Build", createdAt: at },
    { id: "b", conversationId: "c", from: "lead", to: "peer", peerSessionId: "web",
      text: "Build Web", createdAt: at },
    { id: "c", conversationId: "c", from: "peer", to: "lead", peerSessionId: "web",
      text: "Done", createdAt: at },
    { id: "other", conversationId: "x", from: "user", to: "lead", text: "Wrong", createdAt: at }
  ];
  data.messages = messages;
  assert.deepEqual(recentActivity(data, "c").map(a => a.label), [
    "Todo Web gửi kết quả", "Lead giao việc cho Todo Web", "Bạn gửi yêu cầu cho Lead"
  ]);
  assert.equal(recentActivity(data, "c", 1).length, 1);
});
