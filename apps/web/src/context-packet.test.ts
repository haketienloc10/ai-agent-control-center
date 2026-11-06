import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContextPacket, Conversation, Message, Snapshot, TaskBrief } from "@aacc/contracts";
import { ContextPacketView } from "./components/ContextPacketView.js";
import { ConversationFeed } from "./components/ConversationFeed.js";
import { AgentMonitor } from "./components/AgentMonitor.js";

const time = "2026-11-06T08:00:00Z";
const brief: TaskBrief = {
  goal: "Todo full-stack",
  acceptanceCriteria: ["CRUD qua Web"],
  verified: [{ finding: "API test đã chạy", evidenceRefs: ["peer-report-1"] }],
  preliminary: ["Discovery thấy Vite proxy"],
  unknowns: ["Browser E2E"],
  nextDecision: "Giao Peer Web xác minh"
};
const packet: ContextPacket = {
  originalRequest: { messageId: "user-1", text: "Tạo Todo List với backend storage" },
  taskBrief: brief,
  sources: [{
    messageId: "discovery-report-1", from: "discovery", kind: "discovery-preliminary",
    text: "Web có Vite proxy; chưa xác minh HTTP integration", createdAt: time
  }],
  expectedResult: "Báo build, HTTP status và giới hạn chưa test"
};
const assignment: Message = {
  id: "assignment", conversationId: "c", from: "lead", to: "peer",
  peerSessionId: "peer", text: "Kiểm tra và chỉ sửa phần thiếu",
  contextPacket: packet, createdAt: time
};
const conversation: Conversation = {
  id: "c", title: "Todo", status: "active", leadSessionId: "lead",
  generation: 0, createdAt: time, updatedAt: time, taskBrief: brief
};
const data: Snapshot = {
  conversations: [conversation], modules: [],
  settings: { lead: {}, discovery: {}, peer: {} },
  sessions: [
    { id: "lead", conversationId: "c", role: "lead", label: "Lead",
      status: "idle", createdAt: time, updatedAt: time },
    { id: "peer", conversationId: "c", role: "peer", label: "Peer Web",
      status: "running", moduleId: "web", createdAt: time, updatedAt: time }
  ],
  messages: [
    { id: "user-1", conversationId: "c", from: "user", to: "lead",
      text: "Tạo Todo List với backend storage", createdAt: time },
    assignment
  ],
  deliveries: [{ id: "d", conversationId: "c", sessionId: "peer",
    messageId: assignment.id, generation: 0, status: "running",
    createdAt: time, updatedAt: time }]
};
test("Context Packet renders exact source text, provenance and Lead expected result", () => {
  const html = renderToStaticMarkup(createElement(ContextPacketView, { packet }));
  assert.match(html, /Context Packet đã gửi cho agent/);
  assert.match(html, /Tạo Todo List với backend storage/);
  assert.match(html, /discovery-preliminary/);
  assert.match(html, /discovery-report-1/);
  assert.match(html, /chưa xác minh HTTP integration/);
  assert.match(html, /Báo build, HTTP status/);
  assert.match(html, /Task Brief/);
});
test("Context Packet stays hidden when routing is off; shown in feed and peer transcript", () => {
  const props = { messages: data.messages, sessions: data.sessions,
    conversationId: "c", onRoutingChange: () => {} };
  const hidden = renderToStaticMarkup(createElement(ConversationFeed,
    { ...props, showRouting: false }));
  assert.doesNotMatch(hidden, /Context Packet đã gửi/);
  const routed = renderToStaticMarkup(createElement(ConversationFeed,
    { ...props, showRouting: true }));
  assert.match(routed, /Context Packet đã gửi/);
  assert.match(routed, /discovery-report-1/);
  const monitor = renderToStaticMarkup(createElement(AgentMonitor, {
    data, conversation, selectedPeerId: "peer", onSelectPeer: () => {}
  }));
  assert.match(monitor, /Task Brief · Lead/);
  assert.match(monitor, /Lead đánh giá đã xác minh/);
  assert.match(monitor, /Context Packet đã gửi/);
  assert.match(monitor, /Browser E2E/);
});
