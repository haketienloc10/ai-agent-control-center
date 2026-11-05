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
    settings: { lead: {}, peer: {} },
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

test("Discovery gets its own status before Lead begins", () => {
  const data = fixture();
  assert.equal(conversationStatus(data, conversation).label, "Discovery đang khám phá");
  data.sessions[1].status = "idle";
  data.deliveries[0].status = "queued";
  assert.equal(conversationStatus(data, conversation).label, "Chờ Discovery");
});

test("Discovery report is hidden by default, routed to Lead, and visible in Discovery transcript", () => {
  const data = fixture();
  data.sessions[1].status = "idle";
  data.deliveries[0].status = "completed";
  data.messages.push({
    id: "report", conversationId: "todo", from: "discovery", to: "lead",
    discoverySessionId: "discovery", text: "## Tổng quan\n\n- **API** đã xác minh",
    createdAt: time
  });
  assert.equal(recentActivity(data, "todo")[0].label, "Discovery gửi báo cáo sơ bộ");
  const base = { messages: data.messages, sessions: data.sessions, conversationId: "todo",
    onRoutingChange: () => {} };
  const hidden = renderToStaticMarkup(createElement(ConversationFeed,
    { ...base, showRouting: false }));
  assert.doesNotMatch(hidden, /Tổng quan/);
  const shown = renderToStaticMarkup(createElement(ConversationFeed,
    { ...base, showRouting: true }));
  assert.match(shown, /Discovery gửi báo cáo sơ bộ cho Lead/);
  assert.match(shown, /Tổng quan/);
  const monitor = renderToStaticMarkup(createElement(AgentMonitor, {
    data, conversation, selectedPeerId: "discovery", onSelectPeer: () => {}
  }));
  assert.match(monitor, /Discovery Session/);
  assert.match(monitor, /Báo cáo sơ bộ gửi Lead/);
  assert.match(monitor, /<strong>API<\/strong>/);
});
