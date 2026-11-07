import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "./coordination-store.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aacc-events-"));
  let store = new CoordinationStore(dir);
  return { dir, get store() { return store; },
    reopen() { store.close(); store = new CoordinationStore(dir); },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function startLead(store: CoordinationStore, conversationId: string) {
  const c = store.conversation(conversationId)!;
  const delivery = store.queued().find(d => d.sessionId === c.leadSessionId)!;
  store.startDelivery(delivery.id);
  return delivery;
}

for (const finished of [false, true]) {
  test(`Phản hồi Lead dài được lưu nguyên văn qua restart khi task ${finished ? "finished" : "active"}`, () => {
    const ctx = fixture();
    try {
      const c = ctx.store.createConversation("Báo cáo dài");
      const lead = startLead(ctx.store, c.id);
      const reply = "  \n# Báo cáo\n\n" + "Nội dung kiểm chứng tiếng Việt.\n".repeat(1000) +
        "\n```ts\nconst result = true;\n```\n\nKết thúc báo cáo.  \n";
      assert.ok(reply.length > 20000);
      if (finished) ctx.store.routeLeadTool(lead.id, "finish", { type: "finish" }, []);
      ctx.store.completeLead(lead.id, reply, finished);
      const assertReply = () => {
        const replies = ctx.store.snapshot().messages.filter(m =>
          m.conversationId === c.id && m.from === "lead" && m.to === "user");
        assert.equal(replies.length, 1);
        assert.equal(replies[0].text, reply);
      };
      assertReply();
      ctx.reopen();
      assertReply();
    } finally { ctx.cleanup(); }
  });
}

test("Lead dispatches and becomes idle until Peer emits an event", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead.id, "spawn-1",
      { type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "web", message: "Build UI" }, ["web"]);
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
        { type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId, message: "Implement " + moduleId }, ["api", "web"]);
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
      { type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "api", message: "API" }, ["api"]);
    ctx.store.routeLeadTool(lead.id, "spawn-2",
      { type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "web", message: "Tests" }, ["api", "web"]);
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
      type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "web", message: "Build UI"
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
      { type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "web", message: "UI" }, ["web"]);
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
    const cmd = { type: "assign_module" as const, expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "web",
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

test("Unknown module is rejected before dispatch; a module Peer belongs to one conversation", () => {
  const ctx = fixture();
  try {
    const a = ctx.store.createConversation("A");
    const b = ctx.store.createConversation("B");
    const lead = startLead(ctx.store, a.id);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "1",
      { type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "ghost", message: "X" }, ["web"]), /Module/);
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 0);
    assert.equal(ctx.store.queued().filter(d => d.conversationId === a.id).length, 0);
    ctx.store.routeLeadTool(lead.id, "2",
      { type: "assign_module", expectedResult: "Báo cáo", moduleId: "web", message: "A" }, ["web"]);
    const leadB = startLead(ctx.store, b.id);
    ctx.store.routeLeadTool(leadB.id, "3",
      { type: "assign_module", expectedResult: "Báo cáo", moduleId: "web", message: "B" }, ["web"]);
    const peers = ctx.store.snapshot().sessions.filter(s => s.role === "peer");
    assert.deepEqual(peers.map(p => p.conversationId), [a.id, b.id]);
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
      type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "web", message: "UI",
      model: "peer-special", effort: "xhigh"
    }, ["web"]);
    ctx.store.routeLeadTool(delivery.id, "spawn-2", {
      type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "api", message: "Tests", effort: "low"
    }, ["web", "api"]);
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
      type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "docs", message: "Docs"
    }, ["web", "api", "docs"]);
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

test("App Settings validate transport and empty values inherit Codex without affecting task lifecycle", () => {
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
      type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "web", message: "Work", model: "custom-model", effort: "high"
    }, ["web"]);
    const peer = ctx.store.snapshot().sessions.find(s => s.role === "peer")!;
    assert.equal(peer.conversationId, c.id);
    assert.equal(peer.model, "custom-model");
    ctx.store.routeLeadTool(lead.id, "finish", { type: "finish" }, []);
    ctx.store.completeLead(lead.id, "## Done", true);
    assert.equal(ctx.store.conversation(c.id)?.status, "finished");
    assert.equal(ctx.store.queued().length, 0, "finish superseded queued deliveries");
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

test("Lead inbox coalesces all 75 new events, excludes history and freezes a running batch", () => {
  const ctx = fixture();
  try {
    const conversation = ctx.store.createConversation("Initial request");
    const first = ctx.store.queued()[0];
    assert.deepEqual(ctx.store.leadInputs(first.id).map(m => m.text), ["Initial request"]);
    ctx.store.startDelivery(first.id);
    // New user events while the Lead turn is running belong to the next turn.
    for (let i = 0; i < 75; i++) ctx.store.postUser(conversation.id, "New event " + i);
    assert.deepEqual(ctx.store.leadInputs(first.id).map(m => m.text), ["Initial request"]);
    const waiting = ctx.store.queued().filter(d => d.sessionId === conversation.leadSessionId);
    assert.equal(waiting.length, 1);
    const queued = waiting[0];
    assert.deepEqual(ctx.store.leadInputs(queued.id).map(m => m.text),
      Array.from({ length: 75 }, (_, i) => "New event " + i));
    assert.equal(queued.eventMessageIds?.length, 75);
    ctx.store.completeLead(first.id, "Lead visible history remains separate");
    assert.equal(ctx.store.snapshot().messages.filter(m => m.to === "user").length, 1);
    ctx.store.startDelivery(queued.id);
    assert.deepEqual(ctx.store.leadInputs(queued.id).map(m => m.text),
      Array.from({ length: 75 }, (_, i) => "New event " + i));
  } finally { ctx.cleanup(); }
});

test("Peer completions and errors in one queued Lead wake-up are delivered without replay", () => {
  const ctx = fixture();
  try {
    const conversation = ctx.store.createConversation("Build app");
    const lead = startLead(ctx.store, conversation.id);
    for (const [i, moduleId] of ["api", "web", "tests"].entries()) {
      ctx.store.routeLeadTool(lead.id, "spawn-" + i,
        { type: "assign_module", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId, message: "Work " + i },
        ["api", "web", "tests"]);
    }
    ctx.store.completeLead(lead.id, "Dispatch complete");
    const peers = ctx.store.queued();
    peers.forEach(p => ctx.store.startDelivery(p.id));
    ctx.store.completePeer(peers[0].id, "API complete");
    ctx.store.failDelivery(peers[1].id, "Web test failed");
    ctx.store.completePeer(peers[2].id, "Tests complete");
    const waiting = ctx.store.queued().filter(d => d.sessionId === conversation.leadSessionId);
    assert.equal(waiting.length, 1);
    assert.deepEqual(ctx.store.leadInputs(waiting[0].id).map(m => m.text),
      ["API complete", "Peer web gặp lỗi: Web test failed", "Tests complete"]);
    assert.equal(ctx.store.leadInputs(waiting[0].id).filter(m => m.from === "system").length, 1);
    assert.ok(ctx.store.snapshot().messages.some(m => m.text === "Dispatch complete"));
    assert.ok(!ctx.store.leadInputs(waiting[0].id).some(m => m.text === "Dispatch complete"));
    ctx.store.startDelivery(waiting[0].id);
    ctx.store.setTurn(conversation.leadSessionId, "codex-ack-1");
    assert.equal(ctx.store.delivery(waiting[0].id)?.codexTurnId, "codex-ack-1");
    ctx.store.completeLead(waiting[0].id, "Reviewed");
    assert.equal(ctx.store.queued().length, 0);
  } finally { ctx.cleanup(); }
});

test("Pending Lead event batch persists across SQLite restart", () => {
  const ctx = fixture();
  try {
    const conversation = ctx.store.createConversation("Task");
    ctx.store.postUser(conversation.id, "Update 1");
    ctx.store.postUser(conversation.id, "Update 2");
    assert.equal(ctx.store.queued().length, 1);
    const id = ctx.store.queued()[0].id;
    ctx.reopen();
    assert.equal(ctx.store.queued()[0].id, id);
    assert.deepEqual(ctx.store.leadInputs(id).map(m => m.text), ["Task", "Update 1", "Update 2"]);
  } finally { ctx.cleanup(); }
});

test("Interrupted Lead turn retains its event batch and acknowledged turn ID without unsafe replay", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("First");
    const first = startLead(ctx.store, c.id);
    ctx.store.setTurn(c.leadSessionId, "codex-turn-1");
    ctx.reopen();
    assert.equal(ctx.store.delivery(first.id)?.status, "interrupted");
    assert.equal(ctx.store.delivery(first.id)?.codexTurnId, "codex-turn-1");
    assert.deepEqual(ctx.store.leadInputs(first.id).map(m => m.text), ["First"]);
    assert.equal(ctx.store.queued().length, 0, "Interrupted input is not blindly replayed");
    ctx.store.postUser(c.id, "Manual follow-up");
    const next = ctx.store.queued()[0];
    assert.deepEqual(ctx.store.leadInputs(next.id).map(m => m.text), ["Manual follow-up"]);
    assert.equal(ctx.store.snapshot().messages.filter(m => m.from === "user").length, 2);
  } finally { ctx.cleanup(); }
});
