import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContextPacket, Conversation, Decision, Message, Snapshot, TaskBrief } from "@aacc/contracts";
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
test("Nội dung chuyển giao giữ nguyên prompt, xuống dòng và Markdown/HTML dạng chữ", () => {
  const prompt = 'ASSIGNMENT: api-01\n\nWORK:\n  **Giữ nguyên**\n<script>alert(1)</script>\n\nEXPECTED_RESULT:\nKết quả & bằng chứng\n';
  const html = renderToStaticMarkup(createElement(ContextPacketView, { prompt }));
  assert.match(html, /<summary>Xem nội dung chuyển giao<\/summary>/);
  assert.ok(html.includes('<pre class="handoff-prompt">' + prompt
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre>'));
  assert.doesNotMatch(html, /<script>|<strong>|<h[1-6]>/);
  assert.doesNotMatch(html, /Context Packet đã gửi|· 0 nguồn/);
});

test("Lịch sử chưa lưu prompt báo thiếu bản ghi, không dựng lại Context Packet", () => {
  const html = renderToStaticMarkup(createElement(ContextPacketView, {}));
  assert.match(html, /Chưa có bản ghi nội dung chuyển giao cho lượt này/);
  assert.doesNotMatch(html, /<pre/);
});

test("Prompt từng lượt chỉ xuất hiện trong luồng điều phối và transcript agent tương ứng", () => {
  const prompt = 'ASSIGNMENT: api-02\n\nCONTINUES: api-01\n\nWORK:\n**Kiểm tra ngày**';
  const snapshot = { ...data, messages: data.messages.map(m => m.id === assignment.id
    ? { ...m, handoffPrompt: prompt } : m) };
  const props = { messages: snapshot.messages, sessions: snapshot.sessions,
    conversationId: "c", onRoutingChange: () => {} };
  const hidden = renderToStaticMarkup(createElement(ConversationFeed, { ...props, showRouting: false }));
  assert.doesNotMatch(hidden, /Xem nội dung chuyển giao|CONTINUES/);
  const routed = renderToStaticMarkup(createElement(ConversationFeed, { ...props, showRouting: true }));
  assert.match(routed, /Xem nội dung chuyển giao/);
  assert.ok(routed.includes(prompt));
  const monitor = renderToStaticMarkup(createElement(AgentMonitor, {
    data: snapshot, conversation, selectedPeerId: "peer", onSelectPeer: () => {}
  }));
  assert.ok(monitor.includes(prompt));
  assert.doesNotMatch(monitor, /Task Brief · Lead/);
  const leadOpen = renderToStaticMarkup(createElement(AgentMonitor, {
    data: snapshot, conversation, selectedPeerId: "lead", onSelectPeer: () => {}
  }));
  assert.match(leadOpen, /Task Brief · Lead/);
  assert.match(leadOpen, /Lead đánh giá đã xác minh/);
});

test("Decision Log opens inside the Lead card", () => {
  const first: Decision = { id: "dec-1", topic: "api-contract", decision: "GET /api/todos",
    rationale: "Hai module dùng chung", affects: ["api", "web"], evidenceRefs: [], createdAt: time };
  const second: Decision = { ...first, id: "dec-2", decision: "GET /api/todos trả { todos }",
    supersedes: "dec-1" };
  const withDecisions: Conversation = { ...conversation, taskBrief: undefined, decisions: [first, second] };
  const snapshot: Snapshot = { ...data, conversations: [withDecisions] };
  const closed = renderToStaticMarkup(createElement(AgentMonitor, {
    data: snapshot, conversation: withDecisions, selectedPeerId: "", onSelectPeer: () => {}
  }));
  assert.match(closed, /class="lead-card" aria-expanded="false"/, "decisions alone make the Lead card expandable");
  assert.doesNotMatch(closed, /Decision Log/);
  const open = renderToStaticMarkup(createElement(AgentMonitor, {
    data: snapshot, conversation: withDecisions, selectedPeerId: "lead", onSelectPeer: () => {}
  }));
  assert.match(open, /Decision Log · 2/);
  assert.doesNotMatch(open, /Task Brief · Lead/);
  assert.ok(open.indexOf("trả { todos }") < open.indexOf("GET /api/todos<"), "newest first");
  assert.match(open, /class="superseded"[^]*đã bị thay/);
});
