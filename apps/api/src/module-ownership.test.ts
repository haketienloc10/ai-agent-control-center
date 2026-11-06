import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@aacc/contracts";
import { CoordinationStore } from "./coordination-store.js";
import { Coordinator } from "./coordinator.js";
import type { AgentRuntime } from "./codex-runtime.js";

const modules = ["api", "web"];
const expectedResult = "Báo cáo file đã sửa và lệnh đã chạy";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aacc-ownership-"));
  const store = new CoordinationStore(dir);
  return { store, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function startLead(store: CoordinationStore, conversationId: string) {
  const c = store.conversation(conversationId)!;
  const delivery = store.queued().find(d => d.sessionId === c.leadSessionId)!;
  store.startDelivery(delivery.id);
  return delivery;
}
/** Run the queued Peer turn of `moduleId` to completion. */
function runPeer(store: CoordinationStore, moduleId: string, report: string) {
  const peer = store.snapshot().sessions.find(s => s.role === "peer" && s.moduleId === moduleId)!;
  const delivery = store.queued().find(d => d.sessionId === peer.id)!;
  store.startDelivery(delivery.id);
  store.completePeer(delivery.id, report);
}
const lastPacket = (store: CoordinationStore, moduleId: string) => {
  const peer = store.snapshot().sessions.find(s => s.role === "peer" && s.moduleId === moduleId)!;
  return store.snapshot().messages.filter(m => m.peerSessionId === peer.id && m.from === "lead")
    .at(-1)!.contextPacket!;
};
const decision = (topic: string, text: string, affects: string[]) =>
  ({ type: "record_decision" as const, topic, decision: text, rationale: "Hai module dùng chung", affects });

test("assign_module keeps exactly one Peer per module and reuses its Thread", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead1 = startLead(ctx.store, c.id);
    const first = ctx.store.routeLeadTool(lead1.id, "a1",
      { type: "assign_module", moduleId: "api", message: "API", expectedResult }, modules);
    ctx.store.routeLeadTool(lead1.id, "w1",
      { type: "assign_module", moduleId: "web", message: "Web", expectedResult }, modules);
    assert.match(first, /Peer mới/);
    ctx.store.completeLead(lead1.id, "");
    runPeer(ctx.store, "api", "API xong");
    ctx.store.setThread(ctx.store.snapshot().sessions.find(s => s.moduleId === "api")!.id, "api-thread");
    const lead2 = startLead(ctx.store, c.id);
    const again = ctx.store.routeLeadTool(lead2.id, "a2",
      { type: "assign_module", moduleId: "api", message: "Sửa lỗi", expectedResult, model: "other" }, modules);
    assert.match(again, /dùng lại Thread/);
    assert.match(again, /model\/effort chỉ áp dụng khi tạo Peer/);
    const peers = ctx.store.snapshot().sessions.filter(s => s.role === "peer");
    assert.deepEqual(peers.map(p => [p.moduleId, p.label]), [["api", "Peer api"], ["web", "Peer web"]]);
    const api = peers.find(p => p.moduleId === "api")!;
    assert.equal(api.threadId, "api-thread");
    assert.equal(api.model, undefined, "model is frozen when the Peer was created");
    assert.equal(ctx.store.queued().filter(d => d.sessionId === api.id).length, 1);
  } finally { ctx.cleanup(); }
});

test("Decisions reach only affected Peers, once, and a superseding decision is resent", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead1 = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead1.id, "d1", decision("api-contract", "GET /api/todos", ["api", "web"]), modules);
    ctx.store.routeLeadTool(lead1.id, "d2", decision("storage", "data/todos.json", ["api"]), modules);
    ctx.store.routeLeadTool(lead1.id, "a1",
      { type: "assign_module", moduleId: "api", message: "API", expectedResult }, modules);
    ctx.store.routeLeadTool(lead1.id, "w1",
      { type: "assign_module", moduleId: "web", message: "Web", expectedResult }, modules);
    assert.deepEqual(lastPacket(ctx.store, "api").decisions?.map(d => d.topic), ["api-contract", "storage"]);
    assert.deepEqual(lastPacket(ctx.store, "web").decisions?.map(d => d.topic), ["api-contract"]);
    ctx.store.completeLead(lead1.id, "");
    runPeer(ctx.store, "api", "API xong");
    runPeer(ctx.store, "web", "Web xong");

    const lead2 = startLead(ctx.store, c.id);
    const replaced = ctx.store.routeLeadTool(lead2.id, "d3",
      decision("api-contract", "GET /api/todos trả { todos }", ["api", "web"]), modules);
    assert.match(replaced, /thay quyết định/);
    assert.match(replaced, /Peer đang giữ bản cũ: api, web/);
    ctx.store.routeLeadTool(lead2.id, "a2",
      { type: "assign_module", moduleId: "api", message: "Đổi response", expectedResult }, modules);
    const api = lastPacket(ctx.store, "api");
    assert.deepEqual(api.decisions?.map(d => d.decision), ["GET /api/todos trả { todos }"]);
    assert.equal(api.decisions?.[0].supersedes, ctx.store.conversation(c.id)!.decisions![0].id);
    assert.deepEqual(api.omitted?.decisionIds, [ctx.store.conversation(c.id)!.decisions![1].id],
      "unchanged storage decision is already in the Thread");
    assert.equal(ctx.store.conversation(c.id)!.decisions!.length, 3, "Decision Log is append-only");
  } finally { ctx.cleanup(); }
});

test("record_decision validates modules and evidence atomically; Discovery gets no decisions", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead = startLead(ctx.store, c.id);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "x1",
      decision("port", "3001", ["api", "ghost"]), modules), /Module không tồn tại: ghost/);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "x2",
      { ...decision("port", "3001", ["api"]), evidenceRefs: ["missing"] }, modules), /contextRef/);
    assert.equal(ctx.store.conversation(c.id)!.decisions, undefined);
    ctx.store.routeLeadTool(lead.id, "ok", decision("port", "3001", ["api", "web"]), modules, true);
    ctx.store.routeLeadTool(lead.id, "disc",
      { type: "spawn_discovery", message: "Khảo sát", expectedResult }, modules, true);
    const packet = ctx.store.snapshot().messages.find(m => m.to === "discovery")!.contextPacket!;
    assert.equal(packet.decisions, undefined);
    assert.equal(packet.omitted?.decisionIds, undefined);
  } finally { ctx.cleanup(); }
});

test("Peer prompt carries decisions as data, and only once per Thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-ownership-runtime-"));
  const store = new CoordinationStore(dir);
  const config: WorkspaceConfig = { lead: { cwd: "/repo/lead" },
    modules: [{ id: "web", label: "Web", path: "/repo/web" }] };
  const prompts: string[] = [];
  let leadTurns = 0;
  const runtime: AgentRuntime = {
    async run(session, _cwd, prompt, hooks) {
      hooks.onThread(session.id + "-thread");
      hooks.onTurn(session.id + "-turn-" + prompts.length);
      if (session.role === "peer") { prompts.push(prompt); return "Peer báo cáo " + prompts.length; }
      leadTurns++;
      if (leadTurns === 1) {
        await hooks.onLeadTool!("d", decision("api-contract", "GET /api/todos", ["web"]));
        await hooks.onLeadTool!("w1", { type: "assign_module", moduleId: "web", message: "Làm UI", expectedResult });
      } else if (leadTurns === 2) {
        await hooks.onLeadTool!("w2", { type: "assign_module", moduleId: "web", message: "Sửa nhỏ", expectedResult });
      }
      return "";
    }
  };
  try {
    new Coordinator(config, store, runtime);
    store.createConversation("Todo");
    const start = Date.now();
    while (prompts.length < 2) {
      if (Date.now() - start > 5000) throw new Error("Peer turns did not run");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(prompts[0], /DECISIONS_FROM_LEAD: \[\{"id":"[^"]+","topic":"api-contract","decision":"GET \/api\/todos"/);
    assert.doesNotMatch(prompts[1], /DECISIONS_FROM_LEAD/);
    assert.match(prompts[1], /DECISIONS_ALREADY_IN_THREAD: \["[^"]+"\]/);
    assert.equal(store.snapshot().sessions.filter(s => s.role === "peer").length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
