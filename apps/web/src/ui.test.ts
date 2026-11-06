import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Snapshot } from "@aacc/contracts";
import { Sidebar } from "./components/Sidebar.js";
import { TaskHeader } from "./components/TaskHeader.js";
import { AgentMonitor } from "./components/AgentMonitor.js";
import { ConversationFeed } from "./components/ConversationFeed.js";

const now = "2026-11-05T07:00:00Z";
const data: Snapshot = {
  modules: [{ id: "api", label: "Module API", path: "/tmp/module-api" }],
  conversations: [{
    id: "c", title: "Tạo Todo List", status: "active", leadSessionId: "lead",
    generation: 0, createdAt: now, updatedAt: now
  }],
  sessions: [
    { id: "lead", conversationId: "c", label: "Lead", role: "lead",
      status: "idle", createdAt: now, updatedAt: now },
    { id: "peer", conversationId: "c", label: "Todo API", role: "peer",
      moduleId: "api", status: "running", model: "model-a", effort: "medium",
      createdAt: now, updatedAt: now }
  ],
  messages: [
    { id: "a", conversationId: "c", from: "user", to: "lead", text: "Tạo Todo List", createdAt: now },
    { id: "b", conversationId: "c", from: "lead", to: "peer", peerSessionId: "peer",
      text: "Xây API", createdAt: now }
  ],
  deliveries: [{ id: "d", conversationId: "c", sessionId: "peer", messageId: "b",
    status: "running", generation: 0, createdAt: now, updatedAt: now }],
  settings: { lead: { model: "model-lead" }, peer: { model: "model-peer" }, discovery: {} }
};
const nop = () => {};

test("Sidebar and header display real task/agent statuses, never fake completion", () => {
  const sidebar = renderToStaticMarkup(createElement(Sidebar, {
    data, conversations: data.conversations, activeId: "c", connection: "connected",
    onSelect: nop, onNew: nop, onSettings: nop
  }));
  assert.match(sidebar, /Đang chờ Peer/);
  assert.match(sidebar, /Backend đã kết nối/);
  assert.doesNotMatch(sidebar, /Chờ xác nhận/);
  const header = renderToStaticMarkup(createElement(TaskHeader, {
    data, conversation: data.conversations[0]
  }));
  assert.match(header, /Peer đang chạy/);
  assert.match(header, />1</);
  assert.match(header, /Idle/);
  assert.doesNotMatch(header, /Đã kết thúc/);
});

test("Monitor distinguishes Peer session running from turn completion and uses actual messages", () => {
  const view = renderToStaticMarkup(createElement(AgentMonitor, {
    data, conversation: data.conversations[0], selectedPeerId: "", onSelectPeer: nop
  }));
  assert.match(view, /Todo API/);
  assert.match(view, /Đang chạy/);
  assert.match(view, /Lead đang chờ kết quả Peer/);
  assert.match(view, /Lead giao việc cho Todo API/);
  assert.match(view, /Module API/);
  assert.doesNotMatch(view, /Lead đã finish task/);
});

test("Conversation mode hides routing by default and can expose it on demand", () => {
  const base = { messages: data.messages, sessions: data.sessions,
    conversationId: "c", onRoutingChange: nop };
  const normal = renderToStaticMarkup(createElement(ConversationFeed,
    { ...base, showRouting: false }));
  assert.match(normal, /Tạo Todo List/);
  assert.doesNotMatch(normal, /Lead giao việc cho Todo API/);
  const full = renderToStaticMarkup(createElement(ConversationFeed,
    { ...base, showRouting: true }));
  assert.match(full, /Lead giao việc cho Todo API/);
});
