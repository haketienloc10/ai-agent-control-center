import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskBrief, WorkspaceConfig } from "@aacc/contracts";
import { CoordinationStore } from "./coordination-store.js";
import { Coordinator } from "./coordinator.js";
import type { AgentRuntime } from "./codex-runtime.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aacc-context-packet-"));
  let store = new CoordinationStore(dir);
  return {
    get store() { return store; },
    reopen() { store.close(); store = new CoordinationStore(dir); },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}
const config: WorkspaceConfig = {
  lead: { cwd: "/repo/lead" },
  discovery: { cwd: "/repo/discovery", enabled: true },
  modules: [
    { id: "api", label: "API", path: "/repo/api" },
    { id: "web", label: "Web", path: "/repo/web" }
  ]
};
function startLead(store: CoordinationStore, conversationId: string) {
  const c = store.conversation(conversationId)!;
  const delivery = store.queued().find(d => d.sessionId === c.leadSessionId)!;
  store.startDelivery(delivery.id);
  return delivery;
}
function brief(preliminary: string[] = [], verified: TaskBrief["verified"] = []): TaskBrief {
  return {
    goal: "Todo full-stack", acceptanceCriteria: ["CRUD through frontend", "Backend persistence"],
    verified, preliminary, unknowns: ["Browser UI E2E chưa chạy"],
    nextDecision: "Xác minh contract trước khi sửa frontend"
  };
}
const expectedResult = "Báo file đã kiểm tra, lệnh/test thật, điểm chưa xác minh";

test("Lead persists Task Brief and hands independent workers exact immutable Context Packets", () => {
  const ctx = fixture();
  try {
    const task = ctx.store.createConversation("User: Todo List; backend giữ dữ liệu");
    const lead = startLead(ctx.store, task.id);
    const update = ctx.store.postUser(task.id, "Yêu cầu bổ sung: giữ dữ liệu sau restart");
    ctx.store.routeLeadTool(lead.id, "brief-1",
      { type: "update_task_brief", brief: brief(["API có thể đã có CRUD"]) }, ["api"], true);
    ctx.store.routeLeadTool(lead.id, "discover", {
      type: "spawn_discovery", message: "Khảo sát sơ bộ API và Web",
      expectedResult: "Bản đồ module và điểm chưa rõ", contextRefs: [update.id]
    }, ["api", "web"], true);
    const discoveryDelivery = ctx.store.queued().find(d =>
      ctx.store.session(d.sessionId)?.role === "discovery")!;
    const discoveryOrder = ctx.store.input(discoveryDelivery.id)!;
    assert.equal(discoveryOrder.contextPacket?.originalRequest.text,
      "User: Todo List; backend giữ dữ liệu");
    assert.equal(discoveryOrder.contextPacket?.originalRequest.messageId,
      ctx.store.snapshot().messages.find(m => m.from === "user")?.id);
    assert.deepEqual(discoveryOrder.contextPacket?.sources.map(s => s.messageId), [update.id]);
    assert.equal(discoveryOrder.contextPacket?.sources[0].kind, "user-request");
    assert.deepEqual(discoveryOrder.contextPacket?.taskBrief?.preliminary,
      ["API có thể đã có CRUD"]);
    assert.equal(discoveryOrder.contextPacket?.expectedResult, "Bản đồ module và điểm chưa rõ");
    ctx.store.completeLead(lead.id, "");
    ctx.store.startDelivery(discoveryDelivery.id);
    ctx.store.completeDiscovery(discoveryDelivery.id, "API có CRUD; Web có Vite proxy (sơ bộ)");
    const discoveryReport = ctx.store.snapshot().messages.find(m => m.from === "discovery")!;
    assert.equal(discoveryReport.to, "lead");
    const resumed = startLead(ctx.store, task.id);
    ctx.store.routeLeadTool(resumed.id, "brief-2", {
      type: "update_task_brief", brief: brief(["Discovery báo API có CRUD; chưa xác minh"])
    }, ["web"], true);
    ctx.store.routeLeadTool(resumed.id, "spawn-web", {
      type: "spawn_peer", moduleId: "web",
      message: "Xác minh contract Web; chỉ sửa chỗ thiếu, giữ thay đổi đã có",
      expectedResult, contextRefs: [discoveryReport.id, update.id]
    }, ["web"], true);
    const peerDelivery = ctx.store.queued().find(d =>
      ctx.store.session(d.sessionId)?.role === "peer")!;
    const assignment = ctx.store.input(peerDelivery.id)!;
    const packet = structuredClone(assignment.contextPacket)!;
    assert.deepEqual(packet.sources.map(s => s.kind),
      ["discovery-preliminary", "user-request"]);
    assert.deepEqual(packet.sources.map(s => s.messageId), [discoveryReport.id, update.id]);
    assert.equal(packet.sources[0].text, discoveryReport.text);
    assert.deepEqual(packet.taskBrief?.preliminary,
      ["Discovery báo API có CRUD; chưa xác minh"]);
    assert.equal(packet.expectedResult, expectedResult);
    ctx.store.completeLead(resumed.id, "");
    ctx.store.postUser(task.id, "New request: add sorting");
    assert.deepEqual(ctx.store.input(peerDelivery.id)?.contextPacket, packet,
      "a later user message cannot mutate the handed-off context");
    ctx.reopen();
    assert.deepEqual(ctx.store.input(peerDelivery.id)?.contextPacket, packet,
      "context must survive SQLite restart without rereading conversation");
  } finally { ctx.cleanup(); }
});

test("contextRefs reject foreign, nonexistent, duplicate, oversized sources atomically", () => {
  const ctx = fixture();
  try {
    const a = ctx.store.createConversation("Task A");
    const b = ctx.store.createConversation("Task B");
    const external = ctx.store.snapshot().messages.find(m =>
      m.conversationId === b.id && m.from === "user")!;
    const lead = startLead(ctx.store, a.id);
    const command = (refs: string[]) => ({
      type: "spawn_peer" as const, moduleId: "api",
      message: "Xác minh implementation", expectedResult, contextRefs: refs
    });
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "foreign",
      command([external.id]), ["api"], true), /contextRef không thuộc conversation/);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "missing",
      command(["invalid"]), ["api"], true), /contextRef không thuộc conversation/);
    const origin = ctx.store.snapshot().messages.find(m => m.conversationId === a.id &&
      m.from === "user")!;
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "duplicate",
      command([origin.id, origin.id]), ["api"], true), /contextRefs/);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "no-outcome",
      { ...command([]), expectedResult: "" }, ["api"], true), /expectedResult/);
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 0);
    assert.equal(ctx.store.snapshot().messages.filter(m => m.to === "peer").length, 0);
    assert.equal(ctx.store.delivery(lead.id)?.routingPhase, undefined);
    const large1 = ctx.store.postUser(a.id, "A".repeat(17000));
    const large2 = ctx.store.postUser(a.id, "B".repeat(17000));
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "large",
      command([large1.id, large2.id]), ["api"], true), /30000/);
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 0);
  } finally { ctx.cleanup(); }
});

test("Task Brief verified findings require same-conversation evidence, not Discovery preliminary", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo");
    const lead = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead.id, "discover", {
      type: "spawn_discovery", message: "Khảo sát sơ bộ",
      expectedResult: "Tổng quan", contextRefs: []
    }, [], true);
    ctx.store.completeLead(lead.id, "");
    const d = ctx.store.queued()[0];
    ctx.store.startDelivery(d.id);
    ctx.store.completeDiscovery(d.id, "Có vẻ API đã đủ");
    const report = ctx.store.snapshot().messages.find(m => m.from === "discovery")!;
    const wake = startLead(ctx.store, c.id);
    assert.throws(() => ctx.store.routeLeadTool(wake.id, "unverified", {
      type: "update_task_brief",
      brief: brief([], [{ finding: "API đã đủ", evidenceRefs: [report.id] }])
    }, [], true), /không thể coi báo cáo sơ bộ|Không thể coi báo cáo sơ bộ/);
    assert.equal(ctx.store.conversation(c.id)?.taskBrief, undefined);
    const foreign = ctx.store.createConversation("Another task");
    const foreignMsg = ctx.store.snapshot().messages.find(m => m.conversationId === foreign.id &&
      m.from === "user")!;
    assert.throws(() => ctx.store.routeLeadTool(wake.id, "foreign", {
      type: "update_task_brief",
      brief: brief([], [{ finding: "API đủ", evidenceRefs: [foreignMsg.id] }])
    }, [], true), /contextRef không thuộc conversation/);
    ctx.store.routeLeadTool(wake.id, "preliminary", {
      type: "update_task_brief", brief: brief(["Discovery mới đánh giá sơ bộ"])
    }, [], true);
    assert.deepEqual(ctx.store.conversation(c.id)?.taskBrief?.preliminary,
      ["Discovery mới đánh giá sơ bộ"]);
    ctx.reopen();
    assert.equal(ctx.store.conversation(c.id)?.taskBrief?.goal, "Todo full-stack");
  } finally { ctx.cleanup(); }
});

test("Peer runtime receives the original request, selected sources and outcome, not Lead history", async () => {
  const ctx = fixture();
  let sawPeer = false;
  const runtime: AgentRuntime = {
    async run(session, _cwd, prompt, hooks) {
      hooks.onThread(session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      if (session.role === "lead") {
        if (!sawPeer) {
          await hooks.onLeadTool!("spawn", {
            type: "spawn_peer", moduleId: "web", message: "Verify Todo UI",
            expectedResult: "Run typecheck/build and report evidence", contextRefs: []
          });
          return "Do not send this unreferenced Lead reply to Peer";
        }
        return "Lead received Peer results";
      }
      assert.equal(session.role, "peer");
      sawPeer = true;
      assert.match(prompt, /ORIGINAL_USER_REQUEST:/);
      assert.match(prompt, /Todo original requirement/);
      assert.match(prompt, /LEAD_EXPECTED_RESULT: Run typecheck\/build and report evidence/);
      assert.match(prompt, /LEAD_MESSAGE: Verify Todo UI/);
      assert.match(prompt, /SUPPORTING_CONTEXT: \[\]/);
      assert.doesNotMatch(prompt, /Do not send this unreferenced Lead reply to Peer/);
      return "Peer passed build";
    }
  };
  try {
    new Coordinator(config, ctx.store, runtime);
    const c = ctx.store.createConversation("Todo original requirement");
    const start = Date.now();
    while (!ctx.store.snapshot().messages.some(m => m.from === "peer")) {
      if (Date.now() - start > 5000) throw new Error("Peer did not report");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(ctx.store.conversation(c.id)?.status, "active");
    assert.equal(sawPeer, true);
  } finally { ctx.cleanup(); }
});
