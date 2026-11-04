import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "./coordination-store.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aacc-coordination-"));
  let store = new CoordinationStore(dir);
  return { dir, get store() { return store; }, reopen() { store.close(); store = new CoordinationStore(dir); },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test("Lead may spawn multiple Peer sessions in one module; all messages only route via Lead", () => {
  const ctx = fixture();
  try {
    const conversation = ctx.store.createConversation("Create README");
    const first = ctx.store.queued()[0];
    ctx.store.startDelivery(first.id);
    ctx.store.completeLead(first.id, { reply: "Đang giao Web", commands: [
      { type: "spawn_peer", moduleId: "web", message: "Đọc source", label: "Web reader" },
      { type: "spawn_peer", moduleId: "web", message: "Viết README", label: "Web writer" }
    ] }, ["web", "api"]);
    const peers = ctx.store.snapshot().sessions.filter(s => s.role === "peer");
    assert.equal(peers.length, 2);
    assert.notEqual(peers[0].id, peers[1].id);
    const queued = ctx.store.queued();
    assert.deepEqual(queued.map(d => d.sessionId), peers.map(p => p.id));
    ctx.store.startDelivery(queued[0].id);
    ctx.store.completePeer(queued[0].id, "Source có npm run build");
    const next = ctx.store.queued().find(d => d.sessionId === conversation.leadSessionId);
    assert.ok(next, "Peer response must be automatically addressed to Lead");
    assert.equal(ctx.store.input(next.id)?.from, "peer");
    assert.equal(ctx.store.input(next.id)?.to, "lead");
    assert.ok(ctx.store.snapshot().messages.every(m =>
      !(m.from === "peer" && m.to === "peer")), "No Peer-to-Peer message");
    ctx.store.startDelivery(next.id);
    ctx.store.completeLead(next.id, { commands: [
      { type: "send_peer", sessionId: peers[1].id, message: "Bổ sung command build" }
    ] }, ["web"]);
    assert.equal(ctx.store.queued().filter(d => d.sessionId === peers[1].id).length, 2);
    assert.equal(ctx.store.snapshot().messages.filter(m => m.from === "lead" &&
      m.to === "peer" && m.peerSessionId === peers[1].id).length, 2);
  } finally { ctx.cleanup(); }
});

test("Finish is Lead-owned, not gated by review or approval; user may reopen", () => {
  const ctx = fixture();
  try {
    const conversation = ctx.store.createConversation("Write docs");
    const task = ctx.store.queued()[0];
    ctx.store.startDelivery(task.id);
    ctx.store.completeLead(task.id, { commands: [{ type: "finish", summary: "Đã hoàn thành" }] }, []);
    assert.equal(ctx.store.conversation(conversation.id)?.status, "finished");
    assert.ok(ctx.store.snapshot().messages.some(m => m.text === "Đã hoàn thành" && m.from === "lead"));
    ctx.store.postUser(conversation.id, "Bổ sung mục cài đặt");
    assert.equal(ctx.store.conversation(conversation.id)?.status, "active");
    assert.equal(ctx.store.queued().length, 1);
  } finally { ctx.cleanup(); }
});

test("Durable SQLite messages and sessions, crash never replays running turn", () => {
  const ctx = fixture();
  try {
    const conversation = ctx.store.createConversation("Read Web");
    const lead = ctx.store.queued()[0];
    ctx.store.startDelivery(lead.id);
    ctx.store.setThread(conversation.leadSessionId, "lead-t1");
    ctx.reopen();
    assert.equal(ctx.store.delivery(lead.id)?.status, "interrupted");
    assert.equal(ctx.store.session(conversation.leadSessionId)?.threadId, "lead-t1");
    assert.equal(ctx.store.queued().length, 0);
    assert.ok(ctx.store.snapshot().messages.some(m => m.from === "system" &&
      m.text.includes("Không tự chạy lại")));
    ctx.store.postUser(conversation.id, "Tiếp tục xem Web");
    assert.equal(ctx.store.queued().length, 1);
  } finally { ctx.cleanup(); }
});

test("Reject forged Peer session and unknown module without dispatching wrong agent", () => {
  const ctx = fixture();
  try {
    const first = ctx.store.createConversation("Test");
    const second = ctx.store.createConversation("Another");
    const f = ctx.store.queued().find(d => d.conversationId === first.id)!;
    ctx.store.startDelivery(f.id);
    ctx.store.completeLead(f.id, { commands: [
      { type: "spawn_peer", moduleId: "ghost", message: "Wrong" },
      { type: "send_peer", sessionId: second.leadSessionId, message: "Try bypass" }
    ] }, ["web"]);
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 0);
    assert.equal(ctx.store.snapshot().messages.filter(m => m.from === "system").length, 4);
    assert.equal(ctx.store.queued().filter(d => d.conversationId === first.id).length, 2);
    assert.ok(ctx.store.queued().filter(d => d.conversationId === first.id).every(
      d => ctx.store.input(d.id)?.to === "lead"));
  } finally { ctx.cleanup(); }
});

test("Codex dynamic tool actions execute once and persist callId across restart", () => {
  const ctx = fixture();
  try {
    const conversation = ctx.store.createConversation("Todo fullstack");
    const lead = ctx.store.queued()[0];
    ctx.store.startDelivery(lead.id);
    ctx.store.setToolProtocol(conversation.leadSessionId, "dynamic");
    const command = { type: "spawn_peer" as const, moduleId: "web", label: "Todo Web",
      message: 'GET /api/todos trả {"todos":[{"id":1,"title":"Task"}]}' };
    const first = ctx.store.routeLeadTool(lead.id, "thread:call-1", command, ["api", "web"]);
    assert.match(first, /sessionId=/);
    const repeated = ctx.store.routeLeadTool(lead.id, "thread:call-1", command, ["api", "web"]);
    assert.match(repeated, /Already executed/);
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 1);
    assert.equal(ctx.store.queued().length, 1);
    assert.equal(ctx.store.snapshot().messages.filter(m => m.from === "lead" && m.to === "peer").length, 1);
    ctx.reopen();
    assert.equal(ctx.store.session(conversation.leadSessionId)?.toolProtocol, "dynamic");
    assert.equal(ctx.store.session(conversation.leadSessionId)?.handledToolCalls?.length, 1);
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 1);
    assert.equal(ctx.store.queued().length, 1, "Peer delivery queued before crash remains queued");
  } finally { ctx.cleanup(); }
});

test("Dynamic routing tool cannot address foreign session or unknown module", () => {
  const ctx = fixture();
  try {
    const a = ctx.store.createConversation("A");
    const b = ctx.store.createConversation("B");
    const lead = ctx.store.queued().find(d => d.conversationId === a.id)!;
    ctx.store.startDelivery(lead.id);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "c1",
      { type: "spawn_peer", moduleId: "unknown", message: "X" }, ["web"]), /Module/);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "c2",
      { type: "send_peer", sessionId: b.leadSessionId, message: "X" }, ["web"]), /Peer session/);
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 0);
    assert.equal(ctx.store.queued().filter(d => d.conversationId === a.id).length, 0);
  } finally { ctx.cleanup(); }
});
