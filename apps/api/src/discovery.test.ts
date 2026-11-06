import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@aacc/contracts";
import { loadWorkspaceConfig } from "./config.js";
import { CoordinationStore } from "./coordination-store.js";
import { Coordinator } from "./coordinator.js";
import type { AgentRuntime } from "./codex-runtime.js";

const config: WorkspaceConfig = {
  lead: { cwd: "/work/lead" },
  discovery: { cwd: "/work/discovery", enabled: true },
  modules: [
    { id: "api", label: "API", path: "/work/api" },
    { id: "web", label: "Web", path: "/work/web" }
  ]
};
async function until(check: () => boolean, timeout = 4000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for coordination");
    await new Promise(resolve => setTimeout(resolve, 8));
  }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aacc-lead-discovery-"));
  let store = new CoordinationStore(dir);
  return {
    get store() { return store; },
    reopen() { store.close(); store = new CoordinationStore(dir); },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}
function startLead(store: CoordinationStore, id: string) {
  const c = store.conversation(id)!;
  const delivery = store.queued().find(d => d.sessionId === c.leadSessionId)!;
  store.startDelivery(delivery.id);
  return delivery;
}
function spawn(store: CoordinationStore, leadId: string, callId = "spawn") {
  return store.routeLeadTool(leadId, callId,
    { type: "spawn_discovery", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", message: "Khảo sát API và Web ở mức tổng quan" },
    ["api", "web"], true);
}
function discoverySession(store: CoordinationStore) {
  return store.snapshot().sessions.find(s => s.role === "discovery")!;
}

test("New tasks begin with Lead; only Lead can spawn optional Discovery", () => {
  const ctx = fixture();
  try {
    const task = ctx.store.createConversation("Tạo Todo API và Web");
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "discovery").length, 0);
    assert.equal(ctx.store.queued()[0].sessionId, task.leadSessionId);
    const lead = startLead(ctx.store, task.id);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "disabled",
      { type: "spawn_discovery", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", message: "Khảo sát" }, [], false), /chưa được cấu hình/);
    const text = spawn(ctx.store, lead.id, "spawn-enabled");
    assert.match(text, /sessionId=/);
    const d = discoverySession(ctx.store);
    assert.notEqual(d.id, task.leadSessionId);
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "peer").length, 0);
    assert.equal(ctx.store.queued()[0].sessionId, d.id);
    const outbound = ctx.store.input(ctx.store.queued()[0].id)!;
    assert.equal(outbound.from, "lead");
    assert.equal(outbound.to, "discovery");
    assert.equal(outbound.discoverySessionId, d.id);
    assert.equal(outbound.peerSessionId, undefined);
    assert.match(outbound.text, /Khảo sát API và Web/);
    assert.match(ctx.store.routeLeadTool(lead.id, "spawn-enabled",
      { type: "spawn_discovery", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", message: "Khảo sát API và Web ở mức tổng quan" },
      ["api", "web"], true), /Already executed/);
    assert.throws(() => spawn(ctx.store, lead.id, "duplicate"), /Đã giao Discovery/);
    assert.equal(ctx.store.delivery(lead.id)?.routingPhase, "discovery");
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "same-turn-peer",
      { type: "spawn_peer", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "api", message: "Implement API" }, ["api"], true),
      /Kết thúc Lead turn/);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "same-turn-finish",
      { type: "finish" }, ["api"], true), /Kết thúc Lead turn/);
    assert.equal(ctx.store.snapshot().sessions.some(x => x.role === "peer"), false);
    ctx.store.completeLead(lead.id, "");
    assert.equal(ctx.store.conversation(task.id)?.status, "active");
  } finally { ctx.cleanup(); }
});

test("Lead dispatches Discovery, waits without polling and receives an independent preliminary report", async () => {
  const ctx = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let leadTurns = 0, discoveryTurns = 0;
  const calls: string[] = [];
  const runtime: AgentRuntime = {
    async run(session, cwd, prompt, hooks, selection, roots) {
      hooks.onThread(session.threadId ?? session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      calls.push(session.role);
      if (session.role === "lead") {
        leadTurns++;
        if (leadTurns === 1) {
          assert.match(prompt, /DISCOVERY_ENABLED: true/);
          assert.match(prompt, /spawn_discovery/);
          assert.match(prompt, /ORIGINAL_USER_REQUEST: "Build Todo"/);
          const result = await hooks.onLeadTool!("lead:spawn", {
            type: "spawn_discovery", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", message: "Chỉ khảo sát cấu trúc API và Web"
          });
          assert.match(result, /Discovery/);
          return "Đã giao Discovery";
        }
        assert.match(prompt, /Chỉ khảo sát cấu trúc API và Web/);
        assert.match(prompt, /Đã xác minh/);
        assert.match(prompt, /DISCOVERY_SESSIONS:/);
        return "Đã nhận báo cáo sơ bộ";
      }
      discoveryTurns++;
      assert.equal(session.role, "discovery");
      assert.equal(cwd, config.discovery!.cwd);
      assert.equal(hooks.onLeadTool, undefined);
      assert.match(prompt, /LEAD_MESSAGE: Chỉ khảo sát cấu trúc API và Web/);
      assert.match(prompt, /không kết luận root cause/);
      assert.equal(selection?.model, undefined);
      assert.equal(selection?.effort, undefined);
      assert.deepEqual(roots, ["/work/discovery", "/work/api", "/work/web"]);
      await gate;
      return "### Đã xác minh\n- API, Web\n\n### Chưa rõ\n- API contract";
    }
  };
  try {
    new Coordinator(config, ctx.store, runtime);
    const c = ctx.store.createConversation("Build Todo");
    await until(() => discoveryTurns === 1);
    assert.equal(leadTurns, 1);
    assert.equal(ctx.store.session(c.leadSessionId)?.status, "idle");
    assert.deepEqual(calls, ["lead", "discovery"]);
    release();
    await until(() => leadTurns === 2 && ctx.store.snapshot().messages.some(m =>
      m.text === "Đã nhận báo cáo sơ bộ"));
    assert.deepEqual(calls, ["lead", "discovery", "lead"]);
    const report = ctx.store.snapshot().messages.find(m => m.from === "discovery")!;
    assert.equal(report.to, "lead");
    assert.equal(report.discoverySessionId, discoverySession(ctx.store).id);
    assert.equal(report.peerSessionId, undefined);
    assert.equal(ctx.store.snapshot().messages.filter(m => m.from === "discovery").length, 1);
    assert.equal(ctx.store.queued().length, 0);
  } finally { release(); ctx.cleanup(); }
});

test("send_discovery only works in a new Lead turn after the prior Discovery report", () => {
  const ctx = fixture();
  try {
    const a = ctx.store.createConversation("A");
    const b = ctx.store.createConversation("B");
    const leadA = startLead(ctx.store, a.id);
    const leadB = startLead(ctx.store, b.id);
    spawn(ctx.store, leadA.id);
    const d = discoverySession(ctx.store);
    const original = ctx.store.queued()[0];
    ctx.store.startDelivery(original.id);
    ctx.store.setThread(d.id, "thread-1");
    const cmd = { type: "send_discovery" as const, expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", sessionId: d.id,
      message: "Bổ sung sơ bộ: xem entry points" };
    assert.throws(() => ctx.store.routeLeadTool(leadA.id, "too-early", cmd, [], true),
      /Kết thúc Lead turn/);
    assert.throws(() => ctx.store.routeLeadTool(leadB.id, "foreign", cmd, [], true),
      /Discovery session/);
    ctx.store.completeLead(leadA.id, "");
    ctx.store.completeDiscovery(original.id, "Đã khảo sát");
    assert.equal(ctx.store.queued().filter(item => item.sessionId === a.leadSessionId).length, 1);
    const wake = startLead(ctx.store, a.id);
    assert.throws(() => ctx.store.routeLeadTool(wake.id, "wrong",
      { ...cmd, sessionId: a.leadSessionId }, [], true), /Discovery session/);
    assert.match(ctx.store.routeLeadTool(wake.id, "followup", cmd, [], true), /sessionId=/);
    assert.match(ctx.store.routeLeadTool(wake.id, "followup", cmd, [], true), /Already executed/);
    assert.throws(() => ctx.store.routeLeadTool(wake.id, "peer-after-followup",
      { type: "spawn_peer", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "api", message: "Build" }, ["api"], true),
      /Kết thúc Lead turn/);
    ctx.store.completeLead(wake.id, "");
    const next = ctx.store.queued().find(item => item.sessionId === d.id)!;
    ctx.store.startDelivery(next.id);
    assert.equal(ctx.store.session(d.id)?.threadId, "thread-1");
    assert.equal(ctx.store.input(next.id)?.text, "Bổ sung sơ bộ: xem entry points");
    ctx.store.completeDiscovery(next.id, "Báo cáo bổ sung");
    assert.equal(ctx.store.snapshot().sessions.filter(s => s.role === "discovery").length, 1);
    assert.equal(ctx.store.queued().filter(item => item.sessionId === a.leadSessionId).length, 1);
  } finally { ctx.cleanup(); }
});

test("Peer-first Lead turn cannot retroactively add Discovery; later turn can request it", () => {
  const ctx = fixture();
  try {
    const task = ctx.store.createConversation("Tạo API");
    const first = startLead(ctx.store, task.id);
    ctx.store.routeLeadTool(first.id, "peer-first",
      { type: "spawn_peer", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "api", message: "Implement" }, ["api"], true);
    assert.equal(ctx.store.delivery(first.id)?.routingPhase, "execution");
    assert.throws(() => spawn(ctx.store, first.id, "discovery-after-peer"),
      /đã giao Peer/);
    assert.equal(ctx.store.snapshot().sessions.filter(x => x.role === "discovery").length, 0);
    ctx.store.completeLead(first.id, "");
    const peer = ctx.store.queued()[0];
    ctx.store.startDelivery(peer.id);
    ctx.store.completePeer(peer.id, "API complete");
    const second = startLead(ctx.store, task.id);
    spawn(ctx.store, second.id);
    assert.equal(ctx.store.snapshot().sessions.filter(x => x.role === "discovery").length, 1);
  } finally { ctx.cleanup(); }
});

test("Discovery failure wakes Lead with evidence gap, not a fake Peer report", async () => {
  const ctx = fixture();
  let leadTurns = 0;
  const runtime: AgentRuntime = {
    async run(session, _cwd, prompt, hooks) {
      hooks.onThread(session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      if (session.role === "discovery") throw new Error("Workspace inaccessible");
      leadTurns++;
      if (leadTurns === 1) {
        await hooks.onLeadTool!("spawn", { type: "spawn_discovery", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", message: "Khảo sát API" });
        return "";
      }
      assert.match(prompt, /Workspace inaccessible/);
      return "Lead sẽ giao Peer nếu cần bằng chứng";
    }
  };
  try {
    new Coordinator(config, ctx.store, runtime);
    const task = ctx.store.createConversation("Build API");
    await until(() => ctx.store.snapshot().messages.some(m => m.text ===
      "Lead sẽ giao Peer nếu cần bằng chứng"));
    assert.equal(leadTurns, 2);
    assert.equal(ctx.store.conversation(task.id)?.status, "active");
    assert.equal(ctx.store.snapshot().sessions.some(s => s.role === "peer"), false);
    assert.ok(ctx.store.snapshot().messages.some(m => m.from === "system" &&
      m.to === "lead" && m.text.includes("Workspace inaccessible")));
  } finally { ctx.cleanup(); }
});

test("Discovery restarted mid-turn is not replayed and wakes Lead just once", () => {
  const ctx = fixture();
  try {
    const task = ctx.store.createConversation("Build API");
    const lead = startLead(ctx.store, task.id);
    spawn(ctx.store, lead.id);
    ctx.store.completeLead(lead.id, "");
    const d = ctx.store.queued()[0];
    ctx.store.startDelivery(d.id);
    ctx.reopen();
    assert.equal(ctx.store.delivery(d.id)?.status, "interrupted");
    assert.equal(ctx.store.session(d.sessionId)?.status, "interrupted");
    const queued = ctx.store.queued();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].sessionId, task.leadSessionId);
    assert.match(ctx.store.input(queued[0].id)?.text ?? "", /Discovery bị gián đoạn/);
    ctx.reopen();
    assert.equal(ctx.store.queued().length, 1);
  } finally { ctx.cleanup(); }
});

test("User follow-ups are stored but do not resume Lead until Discovery resolves", () => {
  const ctx = fixture();
  try {
    const task = ctx.store.createConversation("Build API");
    const lead = startLead(ctx.store, task.id);
    spawn(ctx.store, lead.id);
    ctx.store.completeLead(lead.id, "");
    const d = ctx.store.queued()[0];
    ctx.store.startDelivery(d.id);
    ctx.store.postUser(task.id, "Thêm yêu cầu Web");
    const queuedDuringDiscovery = ctx.store.queued().filter(x =>
      x.sessionId === task.leadSessionId);
    assert.equal(queuedDuringDiscovery.length, 1, "User event is queued durably");
    assert.throws(() => ctx.store.startDelivery(queuedDuringDiscovery[0].id),
      /chờ Discovery/, "Lead cannot start until the report arrives");
    assert.deepEqual(ctx.store.snapshot().messages.filter(m => m.from === "user").map(m => m.text),
      ["Build API", "Thêm yêu cầu Web"]);
    ctx.store.completeDiscovery(d.id, "Khảo sát xong");
    assert.equal(ctx.store.queued().filter(x => x.sessionId === task.leadSessionId).length, 1,
      "Discovery completion batches into the pending Lead wake");
    const leadBatch = ctx.store.queued().find(x => x.sessionId === task.leadSessionId)!;
    assert.deepEqual(ctx.store.leadInputs(leadBatch.id).map(m => m.text),
      ["Thêm yêu cầu Web", "Khảo sát xong"]);
    assert.deepEqual(ctx.store.snapshot().messages.filter(m => m.from === "user").map(m => m.text),
      ["Build API", "Thêm yêu cầu Web"]);
  } finally { ctx.cleanup(); }
});

test("Discovery is a mandatory phase boundary: finish requires the next Lead turn", () => {
  const ctx = fixture();
  try {
    const task = ctx.store.createConversation("Build API");
    const lead = startLead(ctx.store, task.id);
    spawn(ctx.store, lead.id);
    const d = ctx.store.queued()[0];
    ctx.store.startDelivery(d.id);
    assert.throws(() => ctx.store.routeLeadTool(lead.id, "finish-early",
      { type: "finish" }, [], true), /Kết thúc Lead turn/);
    ctx.store.completeLead(lead.id, "");
    assert.equal(ctx.store.conversation(task.id)?.status, "active");
    ctx.store.completeDiscovery(d.id, "Khảo sát sơ bộ");
    const resume = startLead(ctx.store, task.id);
    ctx.store.routeLeadTool(resume.id, "finish-after-report",
      { type: "finish" }, [], true);
    ctx.store.completeLead(resume.id, "## Done", true);
    assert.equal(ctx.store.conversation(task.id)?.status, "finished");
    assert.equal(ctx.store.queued().length, 0);
    ctx.store.postUser(task.id, "Mở lại");
    assert.equal(ctx.store.queued().length, 1);
  } finally { ctx.cleanup(); }
});

test("Queued Lead deliveries cannot start during a Discovery phase, even if queued earlier", () => {
  const ctx = fixture();
  try {
    const task = ctx.store.createConversation("Build API");
    const lead = startLead(ctx.store, task.id);
    // Queue a user follow-up before Discovery starts. It must not bypass the phase.
    ctx.store.postUser(task.id, "Thêm yêu cầu Web");
    const queuedLead = ctx.store.queued().find(d => d.sessionId === task.leadSessionId)!;
    spawn(ctx.store, lead.id);
    ctx.store.completeLead(lead.id, "");
    // Now the Lead session is idle: only the Discovery barrier can prevent this delivery.
    assert.throws(() => ctx.store.startDelivery(queuedLead.id), /chờ Discovery/);
    const discovery = ctx.store.queued().find(d => d.sessionId !== task.leadSessionId)!;
    ctx.store.startDelivery(discovery.id);
    assert.throws(() => ctx.store.startDelivery(queuedLead.id), /chờ Discovery/);
    ctx.store.completeDiscovery(discovery.id, "Đã khảo sát API và Web");
    ctx.store.startDelivery(queuedLead.id);
    assert.equal(ctx.store.session(task.leadSessionId)?.status, "running");
    assert.match(ctx.store.snapshot().messages.find(m => m.from === "discovery")!.text,
      /Đã khảo sát/);
  } finally { ctx.cleanup(); }
});

test("Discovery finishing before Lead turn end cannot be bypassed in that same turn", () => {
  const ctx = fixture();
  try {
    const task = ctx.store.createConversation("Build API");
    const first = startLead(ctx.store, task.id);
    spawn(ctx.store, first.id);
    const discovery = ctx.store.queued()[0];
    ctx.store.startDelivery(discovery.id);
    ctx.store.completeDiscovery(discovery.id, "Fast discovery");
    assert.throws(() => ctx.store.routeLeadTool(first.id, "peer-after-fast-discovery",
      { type: "spawn_peer", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "api", message: "Implement" }, ["api"], true),
      /Kết thúc Lead turn/);
    ctx.store.completeLead(first.id, "");
    const second = startLead(ctx.store, task.id);
    ctx.store.routeLeadTool(second.id, "peer-after-resume",
      { type: "spawn_peer", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", moduleId: "api", message: "Implement" }, ["api"], true);
    assert.equal(ctx.store.snapshot().sessions.filter(x => x.role === "peer").length, 1);
  } finally { ctx.cleanup(); }
});

test("Workspace config accepts only enabled and rejects obsolete Discovery settings", () => {
  const root = mkdtempSync(join(tmpdir(), "aacc-discovery-config-"));
  try {
    for (const dir of ["lead", "discovery", "api", "web"]) mkdirSync(join(root, dir));
    const path = join(root, "workspace.json");
    const body: WorkspaceConfig = {
      lead: { cwd: join(root, "lead") },
      discovery: { cwd: join(root, "discovery"), enabled: true },
      modules: [
        { id: "api", label: "API", path: join(root, "api") },
        { id: "web", label: "Web", path: join(root, "web") }
      ]
    };
    const save = (v: unknown) => writeFileSync(path, JSON.stringify(v));
    save(body);
    assert.deepEqual(loadWorkspaceConfig(path).discovery, body.discovery);
    save({ ...body, discovery: { cwd: body.discovery!.cwd, enabled: false } });
    assert.equal(loadWorkspaceConfig(path).discovery?.enabled, false);
    save({ ...body, discovery: { cwd: body.discovery!.cwd, enabled: "yes" } });
    assert.throws(() => loadWorkspaceConfig(path), /discovery.enabled/);
    save({ ...body, discovery: { cwd: body.discovery!.cwd, mode: "auto" } });
    assert.throws(() => loadWorkspaceConfig(path), /discovery chỉ nhận/);
    save({ ...body, discovery: { cwd: body.lead.cwd } });
    assert.throws(() => loadWorkspaceConfig(path), /thư mục riêng/);
    save({ ...body, discovery: { cwd: body.discovery!.cwd, model: "gpt-test" } });
    assert.throws(() => loadWorkspaceConfig(path), /discovery chỉ nhận/);
    save(body);
    assert.equal(loadWorkspaceConfig(path).discovery?.enabled, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Discovery App Settings are the single source of model/effort for new Discovery turns", async () => {
  const ctx = fixture();
  const calls: Array<{ role: string; model?: string; effort?: string }> = [];
  const runtime: AgentRuntime = {
    async run(session, _cwd, _prompt, hooks, selection) {
      hooks.onThread(session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      calls.push({ role: session.role, model: selection?.model, effort: selection?.effort });
      if (session.role === "lead" && calls.filter(c => c.role === "lead").length === 1) {
        await hooks.onLeadTool!("spawn", { type: "spawn_discovery", expectedResult: "Kết quả, file thay đổi, bằng chứng và lệnh kiểm chứng thực tế", message: "Khảo sát API" });
      }
      return session.role === "discovery" ? "Sơ bộ API" : "Đã nhận báo cáo";
    }
  };
  try {
    const task = ctx.store.createConversation("Build API");
    ctx.store.updateSettings({
      lead: { model: "lead-model", effort: "medium" },
      discovery: { model: "ui-model" },
      peer: { model: "peer-model" }
    });
    new Coordinator(config, ctx.store, runtime);
    await until(() => ctx.store.snapshot().messages.some(m => m.from === "discovery"));
    assert.equal(ctx.store.conversation(task.id)?.status, "active");
    assert.deepEqual(calls.slice(0, 2), [
      { role: "lead", model: "lead-model", effort: "medium" },
      { role: "discovery", model: "ui-model", effort: undefined }
    ]);
  } finally { ctx.cleanup(); }
});
