import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "./coordination-store.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aacc-events-"));
  let store = new CoordinationStore(dir);
  return { get store() { return store; },
    reopen() { store.close(); store = new CoordinationStore(dir); },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function startLead(store: CoordinationStore, conversationId: string) {
  const c = store.conversation(conversationId)!;
  const delivery = store.queued().find(d => d.sessionId === c.leadSessionId)!;
  store.startDelivery(delivery.id);
  return delivery;
}

test("Lead dispatches and becomes idle until Peer emits an event", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead.id, "spawn-1",
      { type: "spawn_peer", moduleId: "web", message: "Build UI" }, ["web"]);
    ctx.store.completeLead(lead.id, "Đã giao");
    assert.equal(ctx.store.conversation(c.id)?.status, "active");
    assert.equal(ctx.store.queued().filter(d => d.sessionId === c.leadSessionId).length, 0);
    const peer = ctx.store.queued()[0];
    ctx.store.startDelivery(peer.id);
    ctx.store.completePeer(peer.id, "UI done");
    const wake = ctx.store.queued().find(d => d.sessionId === c.leadSessionId);
    assert.ok(wake);
    assert.equal(ctx.store.input(wake.id)?.text, "UI done");
  } finally { ctx.cleanup(); }
});

test("Multiple Peer results are batched into one pending Lead wake-up", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead = startLead(ctx.store, c.id);
    for (const [n, moduleId] of ["api", "web"].entries()) {
      ctx.store.routeLeadTool(lead.id, "call-" + n,
        { type: "spawn_peer", moduleId, message: "Implement " + moduleId }, ["api", "web"]);
    }
    ctx.store.completeLead(lead.id, "");
    const work = ctx.store.queued();
    assert.equal(work.length, 2);
    for (const delivery of work) ctx.store.startDelivery(delivery.id);
    ctx.store.completePeer(work[0].id, "API done");
    ctx.store.completePeer(work[1].id, "Web done");
    assert.equal(ctx.store.queued().filter(d => d.sessionId === c.leadSessionId).length, 1);
    assert.equal(ctx.store.snapshot().messages.filter(m => m.from === "peer").length, 2);
    assert.equal(ctx.store.conversation(c.id)?.status, "active");
  } finally { ctx.cleanup(); }
});

test("finish supersedes queued Peer; late result is recorded but cannot wake Lead", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead.id, "spawn-1",
      { type: "spawn_peer", moduleId: "api", message: "API" }, ["api"]);
    ctx.store.routeLeadTool(lead.id, "spawn-2",
      { type: "spawn_peer", moduleId: "api", message: "Tests" }, ["api"]);
    const peers = ctx.store.queued().filter(d => d.sessionId !== c.leadSessionId);
    ctx.store.startDelivery(peers[0].id);
    ctx.store.routeLeadTool(lead.id, "finish",
      { type: "finish", summary: "Todo hoàn thành" }, ["api"]);
    ctx.store.completeLead(lead.id, "Do not repeat completion");
    assert.equal(ctx.store.delivery(peers[1].id)?.status, "superseded");
    ctx.store.completePeer(peers[0].id, "Late API result");
    assert.equal(ctx.store.conversation(c.id)?.status, "finished");
    assert.equal(ctx.store.queued().length, 0);
    assert.equal(ctx.store.snapshot().messages.filter(m => m.text === "Todo hoàn thành").length, 1);
    assert.ok(ctx.store.snapshot().messages.some(m => m.text === "Late API result"));
    assert.ok(!ctx.store.snapshot().messages.some(m => m.text.includes("Do not repeat")));
    ctx.store.postUser(c.id, "Cập nhật Todo");
    assert.equal(ctx.store.conversation(c.id)?.status, "active");
    assert.equal(ctx.store.queued().length, 1);
  } finally { ctx.cleanup(); }
});

test("Peer errors wake Lead once; finish prevents further queued work", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead.id, "spawn",
      { type: "spawn_peer", moduleId: "web", message: "UI" }, ["web"]);
    const peer = ctx.store.queued()[0];
    ctx.store.startDelivery(peer.id);
    ctx.store.completeLead(lead.id, "");
    ctx.store.failDelivery(peer.id, "Dependency error");
    assert.equal(ctx.store.queued().filter(d => d.sessionId === c.leadSessionId).length, 1);
    const wake = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(wake.id, "finish", { type: "finish", summary: "Stopped" }, []);
    ctx.store.completeLead(wake.id, "");
    assert.equal(ctx.store.conversation(c.id)?.status, "finished");
    assert.equal(ctx.store.queued().length, 0);
  } finally { ctx.cleanup(); }
});

test("Idempotent tool calls persist across restart; running turn is never replayed", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead = startLead(ctx.store, c.id);
    ctx.store.setThread(c.leadSessionId, "thread-1");
    const cmd = { type: "spawn_peer" as const, moduleId: "web",
      message: 'GET /api/todos → {"todos":[]}' };
    ctx.store.routeLeadTool(lead.id, "thread-1:call-1", cmd, ["web"]);
    assert.match(ctx.store.routeLeadTool(lead.id, "thread-1:call-1", cmd, ["web"]),
      /Already executed/);
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 1);
    ctx.reopen();
    assert.equal(ctx.store.delivery(lead.id)?.status, "interrupted");
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 1);
    assert.equal(ctx.store.queued().length, 1);
    assert.equal(ctx.store.session(c.leadSessionId)?.threadId, "thread-1");
    assert.equal(ctx.store.session(c.leadSessionId)?.handledToolCalls?.length, 1);
  } finally { ctx.cleanup(); }
});

test("Unknown module and foreign session are rejected before dispatch", () => {
  const ctx = fixture();
  try {
    const a = ctx.store.createConversation("A");
    const b = ctx.store.createConversation("B");
    const lead = startLead(ctx.store, a.id);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "1",
      { type: "spawn_peer", moduleId: "ghost", message: "X" }, ["web"]), /Module/);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "2",
      { type: "send_peer", sessionId: b.leadSessionId, message: "X" }, ["web"]), /Peer session/);
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 0);
    assert.equal(ctx.store.queued().filter(d => d.conversationId === a.id).length, 0);
  } finally { ctx.cleanup(); }
});
