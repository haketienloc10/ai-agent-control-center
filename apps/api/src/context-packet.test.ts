import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    assert.equal(discoveryOrder.contextPacket?.originalRequest?.text,
      "User: Todo List; backend giữ dữ liệu");
    assert.equal(discoveryOrder.contextPacket?.originalRequest?.messageId,
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
      type: "assign_module", moduleId: "web",
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
    assert.equal(packet.peerCheckpoint?.goal, "Todo full-stack");
    assert.equal(packet.taskBrief, undefined, "Peer receives a compact checkpoint instead of the whole assessment");
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
      type: "assign_module" as const, moduleId: "api",
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
            type: "assign_module", moduleId: "web", message: "Verify Todo UI",
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
      assert.match(prompt, /EXPECTED_RESULT:\nRun typecheck\/build and report evidence/);
      assert.match(prompt, /WORK:\nVerify Todo UI/);
      assert.match(prompt, /NEW_SUPPORTING_CONTEXT:\nKhông có nguồn mới\./);
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

test("Reassigning a Peer repeats its checkpoint while deduplicating original request and long sources", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo original requirement");
    const original = ctx.store.snapshot().messages.find(m => m.from === "user")!;
    const lead1 = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead1.id, "brief-1", { type: "update_task_brief", brief: brief() }, ["web"], true);
    const spawnResult = ctx.store.routeLeadTool(lead1.id, "spawn", {
      type: "assign_module", moduleId: "web", message: "Xác minh Web", expectedResult,
      contextRefs: [original.id]
    }, ["web"], true);
    const peer = ctx.store.snapshot().sessions.find(s => s.role === "peer")!;
    const first = ctx.store.input(ctx.store.queued().find(d => d.sessionId === peer.id)!.id)!;
    assert.equal(first.contextPacket?.originalRequest?.text, "Todo original requirement");
    assert.deepEqual(first.contextPacket?.sources, [], "original request must not be duplicated as a source");
    assert.deepEqual(first.contextPacket?.omitted?.sourceIds, [original.id]);
    assert.match(spawnResult, /Không gửi lại 1 nguồn/);
    ctx.store.completeLead(lead1.id, "");
    const firstDelivery = ctx.store.queued().find(d => d.sessionId === peer.id)!;
    ctx.store.startDelivery(firstDelivery.id);
    ctx.store.completePeer(firstDelivery.id, "Báo cáo Web lượt 1");
    const report = ctx.store.snapshot().messages.find(m => m.from === "peer")!;

    const lead2 = startLead(ctx.store, c.id);
    const sendResult = ctx.store.routeLeadTool(lead2.id, "send-1", {
      type: "assign_module", moduleId: "web", message: "Chạy tích hợp", expectedResult,
      contextRefs: [report.id, original.id]
    }, ["web"], true);
    const second = ctx.store.snapshot().messages.filter(m => m.to === "peer").at(-1)!.contextPacket!;
    assert.equal(second.originalRequest, undefined, "Thread already holds the original request");
    assert.equal(second.taskBrief, undefined, "the large assessment stays out of Peer prompts");
    assert.equal(second.peerCheckpoint?.goal, brief().goal, "goal is repeated even when unchanged");
    assert.deepEqual(second.peerCheckpoint?.acceptanceCriteria, brief().acceptanceCriteria);
    assert.equal(second.omitted?.taskBrief, undefined);
    assert.equal(second.peerCheckpoint?.continues, first.id);
    assert.deepEqual(second.sources, [], "Peer's own report is already in its Thread");
    assert.deepEqual(second.omitted?.sourceIds, [report.id, original.id]);
    assert.match(sendResult, /Không gửi lại 2 nguồn/);

    ctx.store.routeLeadTool(lead2.id, "brief-2", {
      type: "update_task_brief", brief: { ...brief(), nextDecision: "Chờ kết quả tích hợp" }
    }, ["web"], true);
    ctx.store.routeLeadTool(lead2.id, "send-2", {
      type: "assign_module", moduleId: "web", message: "Báo thêm cổng đã dùng", expectedResult,
      contextRefs: []
    }, ["web"], true);
    const third = ctx.store.snapshot().messages.filter(m => m.to === "peer").at(-1)!.contextPacket!;
    assert.equal(third.taskBrief, undefined, "changing nextDecision does not resend the full assessment");
    assert.equal(third.peerCheckpoint?.goal, brief().goal);
    assert.equal(third.omitted?.taskBrief, undefined);
  } finally { ctx.cleanup(); }
});

test("Queued A → B → A assignments preserve each checkpoint across restart", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Original");
    const a = { ...brief(), goal: "Mục tiêu A" };
    const b = { ...brief(), goal: "Mục tiêu B", acceptanceCriteria: ["Tiêu chí B"] };
    const firstLead = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(firstLead.id, "a", { type: "update_task_brief", brief: a }, ["api"]);
    ctx.store.routeLeadTool(firstLead.id, "assign-a", { type: "assign_module", moduleId: "api", message: "Làm A", expectedResult }, ["api"]);
    ctx.store.completeLead(firstLead.id, "");
    const first = ctx.store.queued().find(d => ctx.store.session(d.sessionId)?.role === "peer")!;
    ctx.store.startDelivery(first.id); ctx.store.completePeer(first.id, "A xong");
    const lead = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead.id, "b", { type: "update_task_brief", brief: b }, ["api"]);
    ctx.store.routeLeadTool(lead.id, "assign-b", { type: "assign_module", moduleId: "api", message: "Làm B", expectedResult, constraints: ["Giữ B"] }, ["api"]);
    ctx.store.routeLeadTool(lead.id, "a-again", { type: "update_task_brief", brief: a }, ["api"]);
    ctx.store.routeLeadTool(lead.id, "assign-a-again", { type: "assign_module", moduleId: "api", message: "Quay lại A", expectedResult, constraints: ["Giữ A"] }, ["api"]);
    ctx.store.completeLead(lead.id, "");
    const queued = ctx.store.queued().filter(d => ctx.store.session(d.sessionId)?.role === "peer");
    const packets = queued.map(d => ctx.store.input(d.id)!.contextPacket!);
    ctx.reopen();
    for (let i = 0; i < queued.length; i++) {
      assert.deepEqual(ctx.store.input(queued[i].id)?.contextPacket, packets[i]);
      ctx.store.startDelivery(queued[i].id);
      ctx.store.completePeer(queued[i].id, "Xong");
    }
    assert.equal(packets[0].peerCheckpoint?.goal, "Mục tiêu B");
    assert.equal(packets[1].peerCheckpoint?.goal, "Mục tiêu A");
    assert.deepEqual(packets[1].peerCheckpoint?.acceptanceCriteria, a.acceptanceCriteria);
    assert.deepEqual(packets.map(p => p.peerCheckpoint?.constraints), [["Giữ B"], ["Giữ A"]]);
    assert.equal(packets[1].peerCheckpoint?.continues, packets[0].peerCheckpoint?.assignmentId);
  } finally { ctx.cleanup(); }
});

test("Previous context uses Lead summaries, validates received sources atomically and snapshots metadata", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Original");
    const lead1 = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead1.id, "assign", { type: "assign_module", moduleId: "api", message: "Làm", expectedResult }, ["api"]);
    ctx.store.completeLead(lead1.id, "");
    const d = ctx.store.queued()[0]; ctx.store.startDelivery(d.id); ctx.store.completePeer(d.id, "Báo cáo rất dài");
    const report = ctx.store.snapshot().messages.find(m => m.from === "peer")!;
    const newSource = ctx.store.postUser(c.id, "Nguồn mới chưa vào Thread");
    const lead2 = startLead(ctx.store, c.id);
    const command = { type: "assign_module" as const, moduleId: "api", message: "Bổ sung", expectedResult,
      contextRefs: [report.id], previousContext: [{ messageId: report.id, summary: "Lead đánh giá còn thiếu validation" }] };
    const before = ctx.store.snapshot();
    for (const previousContext of [
      [{ messageId: newSource.id, summary: "Chưa nhận" }],
      [{ messageId: report.id, summary: "" }],
      [command.previousContext[0], command.previousContext[0]]
    ]) {
      assert.throws(() => ctx.store.routeLeadTool(lead2.id, "invalid", { ...command, previousContext }, ["api"]), /previousContext/);
      assert.deepEqual(ctx.store.snapshot(), before);
    }
    ctx.store.routeLeadTool(lead2.id, "valid", command, ["api"]);
    const packet = ctx.store.snapshot().messages.filter(m => m.to === "peer").at(-1)!.contextPacket!;
    assert.deepEqual(packet.sources, []);
    assert.deepEqual(packet.previousContext, [{ messageId: report.id, from: "peer", kind: "peer-report",
      createdAt: report.createdAt, summary: "Lead đánh giá còn thiếu validation" }]);
    assert.equal(packet.peerCheckpoint?.goal, "Original", "no Brief: preserve the user's goal without inventing criteria");
    assert.deepEqual(packet.peerCheckpoint?.acceptanceCriteria, []);
    assert.deepEqual(packet.peerCheckpoint?.constraints, []);
    ctx.store.completeLead(lead2.id, "");
    ctx.reopen();
    assert.deepEqual(ctx.store.snapshot().messages.find(m => m.id === packet.peerCheckpoint!.assignmentId)?.contextPacket, packet);
  } finally { ctx.cleanup(); }
});

test("A handoff whose turn never completed is resent in full to the same Peer", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Todo original requirement");
    const lead1 = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead1.id, "spawn", {
      type: "assign_module", moduleId: "api", message: "Xác minh API", expectedResult, contextRefs: []
    }, ["api"], true);
    ctx.store.completeLead(lead1.id, "");
    const peer = ctx.store.snapshot().sessions.find(s => s.role === "peer")!;
    const delivery = ctx.store.queued().find(d => d.sessionId === peer.id)!;
    ctx.store.startDelivery(delivery.id);
    ctx.store.failDelivery(delivery.id, "Codex crashed before the turn finished");
    const lead2 = startLead(ctx.store, c.id);
    ctx.store.routeLeadTool(lead2.id, "retry", {
      type: "assign_module", moduleId: "api", message: "Làm lại", expectedResult, contextRefs: []
    }, ["api"], true);
    const retry = ctx.store.snapshot().messages.filter(m => m.to === "peer").at(-1)!.contextPacket!;
    assert.equal(retry.originalRequest?.text, "Todo original requirement");
    assert.equal(retry.omitted, undefined);
  } finally { ctx.cleanup(); }
});

test("A persisted legacy queued Peer packet keeps its original prompt after upgrade", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aacc-legacy-packet-"));
  let store = new CoordinationStore(directory);
  try {
    const c = store.createConversation("Yêu cầu cũ");
    const lead = startLead(store, c.id);
    store.routeLeadTool(lead.id, "assign", { type: "assign_module", moduleId: "api", message: "Việc cũ", expectedResult }, ["api"]);
    store.completeLead(lead.id, "");
    const state = store.snapshot();
    const assignment = state.messages.find(m => m.to === "peer")!;
    assignment.contextPacket = { originalRequest: { messageId: state.messages[0].id, text: "Yêu cầu cũ" },
      taskBrief: { ...brief(), goal: "Mục tiêu trong packet cũ" }, sources: [], expectedResult };
    state.conversations[0].taskBrief = { ...brief(), goal: "Mục tiêu mới không được rò vào packet cũ" };
    store.close();
    const db = new DatabaseSync(join(directory, "coordination.sqlite"));
    db.prepare("UPDATE snapshot SET body=? WHERE id=1").run(JSON.stringify(state)); db.close();
    store = new CoordinationStore(directory);
    await new Promise<void>((done, reject) => {
      const deadline = setTimeout(() => { store.off("change", check); reject(new Error("Legacy delivery did not complete")); }, 5000);
      const check = () => {
        if (store.snapshot().messages.some(m => m.from === "peer")) {
          clearTimeout(deadline); store.off("change", check); done();
        }
      };
      store.on("change", check);
      const runtime: AgentRuntime = { async run(session, _cwd, prompt, hooks) {
        hooks.onThread(session.id + "-thread"); hooks.onTurn(session.id + "-turn");
        if (session.role === "peer") {
          assert.match(prompt, /TASK_BRIEF_FROM_LEAD:[^]*Mục tiêu trong packet cũ/);
          assert.match(prompt, /LEAD_MESSAGE: Việc cũ/);
          assert.doesNotMatch(prompt, /Mục tiêu mới|CURRENT_GOAL:/);
        }
        return "Đã nhận packet cũ";
      } };
      new Coordinator(config, store, runtime);
    });
    await new Promise<void>(done => setImmediate(done));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
