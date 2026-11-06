import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Snapshot, Conversation } from "@aacc/contracts";
import { AgentMonitor } from "./components/AgentMonitor.js";
import { ConversationFeed } from "./components/ConversationFeed.js";
import { conversationStatus, recentActivity } from "./selectors.js";

const time = "2026-11-05T15:00:00Z";
const conversation: Conversation = {
  id: "todo", leadSessionId: "lead", title: "Todo", status: "active",
  generation: 0, createdAt: time, updatedAt: time
};
function fixture(): Snapshot {
  return {
    conversations: [conversation], modules: [],
    settings: { lead: {}, peer: {}, discovery: {} },
    sessions: [
      { id: "lead", conversationId: "todo", role: "lead", label: "Lead",
        status: "idle", createdAt: time, updatedAt: time },
      { id: "discovery", conversationId: "todo", role: "discovery", label: "Discovery",
        status: "running", createdAt: time, updatedAt: time }
    ],
    messages: [], deliveries: [{
      id: "d", conversationId: "todo", sessionId: "discovery", messageId: "u",
      status: "running", generation: 0, createdAt: time, updatedAt: time
    }]
  };
}

test("Discovery has its own status when Lead has delegated an overview survey", () => {
  const data = fixture();
  assert.equal(conversationStatus(data, conversation).label, "Đang chờ Discovery");
  data.sessions[1].status = "idle";
  data.deliveries[0].status = "queued";
  assert.equal(conversationStatus(data, conversation).label, "Đang xếp hàng");
});

test("Discovery report is hidden by default, routed to Lead, and visible in Discovery transcript", () => {
  const data = fixture();
  data.sessions[1].status = "idle";
  data.deliveries[0].status = "completed";
  data.settings.discovery = { model: "discovery-model", effort: "low" };
  data.messages.push({
    id: "instruction", conversationId: "todo", from: "lead", to: "discovery",
    discoverySessionId: "discovery", text: "Khảo sát sơ bộ API và Web",
    createdAt: time
  });
  data.messages.push({
    id: "report", conversationId: "todo", from: "discovery", to: "lead",
    discoverySessionId: "discovery", text: "## Tổng quan\n\n- **API** đã xác minh",
    createdAt: time
  });
  assert.deepEqual(recentActivity(data, "todo").map(a => a.label),
    ["Discovery gửi báo cáo sơ bộ", "Lead giao Discovery khảo sát sơ bộ"]);
  const base = { messages: data.messages, sessions: data.sessions, conversationId: "todo",
    onRoutingChange: () => {} };
  const hidden = renderToStaticMarkup(createElement(ConversationFeed,
    { ...base, showRouting: false }));
  assert.doesNotMatch(hidden, /Tổng quan/);
  assert.doesNotMatch(hidden, /Khảo sát sơ bộ API và Web/);
  const shown = renderToStaticMarkup(createElement(ConversationFeed,
    { ...base, showRouting: true }));
  assert.match(shown, /Discovery gửi báo cáo sơ bộ cho Lead/);
  assert.match(shown, /Lead giao Discovery khảo sát sơ bộ/);
  assert.match(shown, /Khảo sát sơ bộ API và Web/);
  assert.match(shown, /Tổng quan/);
  const monitor = renderToStaticMarkup(createElement(AgentMonitor, {
    data, conversation, selectedPeerId: "discovery", onSelectPeer: () => {}
  }));
  assert.match(monitor, /Discovery Session/);
  assert.match(monitor, /Model yêu cầu: .*discovery-model/);
  assert.match(monitor, /Effort: .*low/);
  assert.match(monitor, /Trao đổi Lead ↔ Discovery/);
  assert.match(monitor, /Lead giao khám phá/);
  assert.match(monitor, /Khảo sát sơ bộ API và Web/);
  assert.match(monitor, /cùng chính sách thực thi Peer/);
  assert.match(monitor, /<strong>API<\/strong>/);
});
