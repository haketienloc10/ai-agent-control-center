import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
      { type: "finish" }, ["api"]);
    assert.equal(ctx.store.snapshot().messages.filter(m => m.from === "lead" && m.to === "user").length, 0,
      "finish() only changes task state");
    assert.match(ctx.store.routeLeadTool(lead.id, "finish", { type: "finish" }, ["api"]),
      /Already executed/);
    ctx.store.completeLead(lead.id, "## Todo hoàn thành\n\n- **API:** CRUD", true);
    assert.equal(ctx.store.delivery(peers[1].id)?.status, "superseded");
    ctx.store.completePeer(peers[0].id, "Late API result");
    assert.equal(ctx.store.conversation(c.id)?.status, "finished");
    assert.equal(ctx.store.queued().length, 0);
    assert.equal(ctx.store.snapshot().messages.filter(m =>
      m.text === "## Todo hoàn thành\n\n- **API:** CRUD").length, 1);
    assert.ok(ctx.store.snapshot().messages.some(m => m.text === "Late API result"));
    assert.equal(ctx.store.snapshot().messages.filter(m => m.from === "lead" && m.to === "user").length, 1);
    ctx.store.postUser(c.id, "Cập nhật Todo");
    assert.equal(ctx.store.conversation(c.id)?.status, "active");
    assert.equal(ctx.store.queued().length, 1);
  } finally { ctx.cleanup(); }
});

test("Old Peer completion after user reopens task cannot wake a second Lead turn", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead.id, "spawn", {
      type: "spawn_peer", moduleId: "web", message: "Build UI"
    }, ["web"]);
    const peer = ctx.store.queued()[0];
    ctx.store.startDelivery(peer.id);
    ctx.store.routeLeadTool(lead.id, "finish", { type: "finish" }, []);
    ctx.store.completeLead(lead.id, "## Done", true);
    ctx.store.postUser(c.id, "New follow-up");
    const newLead = startLead(ctx.store, c.id);
    ctx.store.completePeer(peer.id, "Old result");
    assert.equal(ctx.store.queued().filter(d => d.sessionId === c.leadSessionId).length, 0);
    ctx.store.completeLead(newLead.id, "Handling new request");
    assert.equal(ctx.store.queued().length, 0);
    assert.equal(ctx.store.conversation(c.id)?.status, "active");
    assert.ok(ctx.store.snapshot().messages.some(m => m.text === "Old result"));
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
    ctx.store.routeLeadTool(wake.id, "finish", { type: "finish" }, []);
    ctx.store.completeLead(wake.id, "", true);
    assert.equal(ctx.store.snapshot().messages.filter(m => m.text === "Task đã hoàn thành.").length, 1);
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


test("App Settings persist; spawn override and defaults are frozen on Peer sessions", () => {
  const ctx = fixture();
  try {
    assert.deepEqual(ctx.store.snapshot().settings, { lead: {}, peer: {}, discovery: {} });
    ctx.store.updateSettings({
      lead: { model: "lead-model", effort: "high" },
      peer: { model: "peer-default", effort: "medium" }
    });
    const c = ctx.store.createConversation("Todo");
    const delivery = ctx.store.queued()[0];
    ctx.store.startDelivery(delivery.id);
    ctx.store.routeLeadTool(delivery.id, "spawn-1", {
      type: "spawn_peer", moduleId: "web", message: "UI",
      model: "peer-special", effort: "xhigh"
    }, ["web"]);
    ctx.store.routeLeadTool(delivery.id, "spawn-2", {
      type: "spawn_peer", moduleId: "web", message: "Tests", effort: "low"
    }, ["web"]);
    const peers = ctx.store.snapshot().sessions.filter(s => s.role === "peer");
    assert.deepEqual(peers.map(s => [s.model, s.effort]), [
      ["peer-special", "xhigh"], ["peer-default", "low"]
    ]);
    ctx.store.updateSettings({
      lead: { model: "lead-new", effort: "low" },
      peer: { model: "peer-new", effort: "high" }
    });
    assert.deepEqual(ctx.store.snapshot().sessions.filter(s => s.role === "peer")
      .map(s => [s.model, s.effort]), [
      ["peer-special", "xhigh"], ["peer-default", "low"]
    ]);
    ctx.store.routeLeadTool(delivery.id, "spawn-3", {
      type: "spawn_peer", moduleId: "web", message: "Docs"
    }, ["web"]);
    const latest = ctx.store.snapshot().sessions.filter(s => s.role === "peer").at(-1)!;
    assert.deepEqual([latest.model, latest.effort], ["peer-new", "high"]);
    assert.equal(latest.conversationId, c.id);
    ctx.reopen();
    assert.deepEqual(ctx.store.settings(), {
      lead: { model: "lead-new", effort: "low" },
      peer: { model: "peer-new", effort: "high" },
      discovery: {}
    });
    assert.deepEqual([ctx.store.session(peers[0].id)?.model, ctx.store.session(peers[0].id)?.effort],
      ["peer-special", "xhigh"]);
    assert.equal(ctx.store.session(latest.id)?.model, "peer-new");
  } finally { ctx.cleanup(); }
});

test("App Settings validate transport and empty values inherit Codex without affecting PR13 lifecycle", () => {
  const ctx = fixture();
  try {
    ctx.store.updateSettings({ lead: { model: "", effort: "" }, peer: {} });
    assert.deepEqual(ctx.store.settings(), { lead: {}, peer: {}, discovery: {} });
    assert.throws(() => ctx.store.updateSettings({ lead: { model: " bad model" }, peer: {} }),
      /model không hợp lệ/);
    assert.throws(() => ctx.store.updateSettings({ lead: {}, peer: { effort: 123 } }),
      /effort không hợp lệ/);
    assert.deepEqual(ctx.store.settings(), { lead: {}, peer: {}, discovery: {} });
    const c = ctx.store.createConversation("Todo");
    const lead = ctx.store.queued()[0];
    ctx.store.startDelivery(lead.id);
    ctx.store.routeLeadTool(lead.id, "override", {
      type: "spawn_peer", moduleId: "web", message: "Work", model: "custom-model", effort: "high"
    }, ["web"]);
    const peer = ctx.store.snapshot().sessions.find(s => s.role === "peer")!;
    assert.equal(peer.conversationId, c.id);
    assert.equal(peer.model, "custom-model");
    ctx.store.routeLeadTool(lead.id, "finish", { type: "finish" }, []);
    ctx.store.completeLead(lead.id, "## Done", true);
    assert.equal(ctx.store.conversation(c.id)?.status, "finished");
    assert.equal(ctx.store.queued().length, 0, "PR13 superseded queued deliveries after finish");
  } finally { ctx.cleanup(); }
});



test("Discovery Model/Effort App Settings validate and persist independently of Lead/Peer", () => {
  const ctx = fixture();
  try {
    ctx.store.updateSettings({
      lead: { model: "lead-current", effort: "medium" },
      discovery: { model: "discovery-custom", effort: "high" },
      peer: { model: "peer-current", effort: "low" }
    });
    assert.deepEqual(ctx.store.settings().discovery, { model: "discovery-custom", effort: "high" });
    assert.throws(() => ctx.store.updateSettings({
      lead: {}, peer: {}, discovery: { model: "invalid model" }
    }), /model không hợp lệ/);
    assert.throws(() => ctx.store.updateSettings({
      lead: {}, peer: {}, discovery: { effort: "bad effort" }
    }), /effort không hợp lệ/);
    assert.deepEqual(ctx.store.settings().discovery, { model: "discovery-custom", effort: "high" });
    ctx.reopen();
    assert.deepEqual(ctx.store.settings().discovery, { model: "discovery-custom", effort: "high" });
    ctx.store.updateSettings({
      lead: { model: "lead-current" },
      peer: {},
      discovery: { model: "", effort: "" }
    });
    assert.deepEqual(ctx.store.settings().discovery, {});
    assert.equal(ctx.store.settings().lead.model, "lead-current");
  } finally { ctx.cleanup(); }
});

test("Old SQLite snapshots without Discovery settings migrate to an empty selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-discovery-settings-migration-"));
  let store: CoordinationStore | undefined;
  try {
    store = new CoordinationStore(dir);
    store.createConversation("Legacy");
    store.close();
    store = undefined;

    const db = new DatabaseSync(join(dir, "coordination.sqlite"));
    try {
      const existing = db.prepare("SELECT body FROM snapshot WHERE id = 1")
        .get() as { body: string };
      const snapshot = JSON.parse(existing.body) as {
        settings: { lead: { model?: string }; peer: Record<string, never>; discovery?: object }
      };
      snapshot.settings = { lead: { model: "legacy-lead" }, peer: {} };
      db.prepare("UPDATE snapshot SET body = ? WHERE id = 1").run(JSON.stringify(snapshot));
    } finally { db.close(); }

    store = new CoordinationStore(dir);
    assert.deepEqual(store.settings(), {
      lead: { model: "legacy-lead" }, peer: {}, discovery: {}
    });
    store.close();
    store = new CoordinationStore(dir);
    assert.deepEqual(store.settings().discovery, {});
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
