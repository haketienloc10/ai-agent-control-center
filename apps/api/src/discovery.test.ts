import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@aacc/contracts";
import { loadWorkspaceConfig } from "./config.js";
import { CoordinationStore } from "./coordination-store.js";
import { Coordinator, shouldDiscover } from "./coordinator.js";
import type { AgentRuntime } from "./codex-runtime.js";

const config: WorkspaceConfig = {
  lead: { cwd: "/work/lead", instructions: "" },
  discovery: { cwd: "/work/discovery", mode: "auto", model: "discovery-model", effort: "low" },
  modules: [
    { id: "api", label: "API", path: "/work/api" },
    { id: "web", label: "Web", path: "/work/web" }
  ]
};

async function until(check: () => boolean, timeout = 4000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for discovery");
    await new Promise(resolve => setTimeout(resolve, 8));
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aacc-discovery-"));
  let store = new CoordinationStore(dir);
  return { get store() { return store; },
    reopen() { store.close(); store = new CoordinationStore(dir); },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("Discovery auto mode is conditional; off/absent skip and always overrides status", () => {
  assert.equal(shouldDiscover(config, "Thêm Todo API và UI"), true);
  assert.equal(shouldDiscover(config, "Sửa bug authentication"), true);
  assert.equal(shouldDiscover(config, "Trạng thái task hiện tại?"), false);
  assert.equal(shouldDiscover(config, "Cho tôi xem tiến độ task"), false);
  assert.equal(shouldDiscover({ ...config, discovery: { cwd: "/work/discovery", mode: "always" } },
    "Trạng thái task hiện tại?"), true);
  assert.equal(shouldDiscover({ ...config, discovery: { cwd: "/work/discovery", mode: "off" } },
    "Thêm Todo API"), false);
  assert.equal(shouldDiscover({ ...config, discovery: undefined }, "Thêm Todo API"), false);
});

test("Discovery owns a separate session and gates the first Lead turn; report is not a Peer result", async () => {
  const ctx = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runs: string[] = [];
  const runtime: AgentRuntime = {
    async run(session, cwd, prompt, hooks, selection, readableRoots) {
      hooks.onThread(session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      runs.push(session.role);
      if (session.role === "discovery") {
        assert.equal(cwd, config.discovery?.cwd);
        assert.match(prompt, /không kết luận root cause/);
        assert.match(prompt, /USER_REQUEST: Thêm Todo API và UI/);
        assert.equal(selection?.model, "discovery-model");
        assert.equal(selection?.effort, "low");
        assert.deepEqual(readableRoots, ["/work/discovery", "/work/api", "/work/web"]);
        assert.equal(hooks.onLeadTool, undefined);
        await gate;
        return "### Đã xác minh\n- API tại /work/api\n\n### Chưa rõ\n- contract thực tế";
      }
      assert.equal(session.role, "lead");
      assert.equal(cwd, config.lead.cwd);
      assert.match(prompt, /ORIGINAL_USER_REQUEST: "Thêm Todo API và UI"/);
      assert.match(prompt, /API tại \/work\/api/);
      assert.match(prompt, /Chưa rõ/);
      return "Lead đã nhận báo cáo Discovery";
    }
  };
  try {
    new Coordinator(config, ctx.store, runtime);
    const task = ctx.store.createConversation("Thêm Todo API và UI", undefined, true);
    const discovery = ctx.store.snapshot().sessions.find(s => s.role === "discovery")!;
    assert.notEqual(discovery.id, task.leadSessionId);
    await until(() => ctx.store.session(discovery.id)?.status === "running");
    assert.deepEqual(runs, ["discovery"], "Lead cannot run before Discovery completes");
    assert.equal(ctx.store.queued().some(d => d.sessionId === task.leadSessionId), false);
    release();
    await until(() => ctx.store.session(task.leadSessionId)?.status === "idle" &&
      ctx.store.snapshot().messages.some(m => m.text === "Lead đã nhận báo cáo Discovery"));
    assert.deepEqual(runs, ["discovery", "lead"]);
    const report = ctx.store.snapshot().messages.find(m => m.from === "discovery")!;
    assert.equal(report.to, "lead");
    assert.equal(report.discoverySessionId, discovery.id);
    assert.equal(report.peerSessionId, undefined);
    assert.equal(ctx.store.snapshot().sessions.some(s => s.role === "peer"), false);
    assert.equal(ctx.store.queued().length, 0);
  } finally { release(); ctx.cleanup(); }
});

test("User follow-up during Discovery does not wake Lead early; Lead sees both messages", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Build API", undefined, true);
    const d = ctx.store.queued()[0];
    const discovery = ctx.store.session(d.sessionId)!;
    assert.equal(discovery.role, "discovery");
    ctx.store.startDelivery(d.id);
    ctx.store.postUser(c.id, "Và hỗ trợ Web");
    assert.equal(ctx.store.queued().length, 0);
    ctx.store.completeDiscovery(d.id, "Chưa rõ API contract");
    const lead = ctx.store.queued().filter(d => d.sessionId === c.leadSessionId);
    assert.equal(lead.length, 1);
    assert.equal(ctx.store.input(lead[0].id)?.from, "discovery");
    assert.deepEqual(ctx.store.snapshot().messages.filter(m => m.from === "user").map(m => m.text),
      ["Build API", "Và hỗ trợ Web"]);
    assert.throws(() => ctx.store.completeDiscovery(d.id, "Duplicate"), /not running/);
  } finally { ctx.cleanup(); }
});

test("Discovery failure wakes Lead with uncertainty, without creating a Peer or re-running Discovery", async () => {
  const ctx = fixture();
  const runs: string[] = [];
  const runtime: AgentRuntime = {
    async run(session, _cwd, prompt, hooks) {
      hooks.onThread(session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      runs.push(session.role);
      if (session.role === "discovery") throw new Error("Workspace inaccessible");
      assert.match(prompt, /Workspace inaccessible/);
      return "Đã nhận cảnh báo; cần Peer khảo sát chi tiết";
    }
  };
  try {
    new Coordinator(config, ctx.store, runtime);
    const c = ctx.store.createConversation("Build API", undefined, true);
    await until(() => ctx.store.snapshot().messages.some(m =>
      m.text === "Đã nhận cảnh báo; cần Peer khảo sát chi tiết"));
    assert.deepEqual(runs, ["discovery", "lead"]);
    assert.equal(ctx.store.conversation(c.id)?.status, "active");
    assert.equal(ctx.store.snapshot().messages.some(m =>
      m.from === "system" && m.to === "lead" && m.text.includes("Workspace inaccessible")), true);
    assert.equal(ctx.store.queued().length, 0);
  } finally { ctx.cleanup(); }
});

test("Interrupted Discovery after restart is not replayed; it queues one Lead fallback", () => {
  const ctx = fixture();
  try {
    const c = ctx.store.createConversation("Build API", undefined, true);
    const d = ctx.store.queued()[0];
    ctx.store.startDelivery(d.id);
    ctx.reopen();
    assert.equal(ctx.store.delivery(d.id)?.status, "interrupted");
    assert.equal(ctx.store.session(d.sessionId)?.status, "interrupted");
    const queued = ctx.store.queued();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].sessionId, c.leadSessionId);
    assert.match(ctx.store.input(queued[0].id)?.text ?? "", /Discovery bị gián đoạn/);
    ctx.reopen();
    assert.equal(ctx.store.queued().length, 1);
  } finally { ctx.cleanup(); }
});

test("Workspace config validates independent discovery cwd, mode and selection", () => {
  const root = mkdtempSync(join(tmpdir(), "aacc-discovery-config-"));
  try {
    for (const dir of ["lead", "discovery", "api", "web"]) mkdirSync(join(root, dir));
    const path = join(root, "workspace.json");
    const body: WorkspaceConfig = {
      lead: { cwd: join(root, "lead"), instructions: "" },
      discovery: { cwd: join(root, "discovery"), mode: "auto", model: "gpt-test", effort: "medium" },
      modules: [
        { id: "api", label: "API", path: join(root, "api") },
        { id: "web", label: "Web", path: join(root, "web") }
      ]
    };
    const save = () => writeFileSync(path, JSON.stringify(body));
    save();
    assert.deepEqual(loadWorkspaceConfig(path).discovery, body.discovery);
    body.discovery!.mode = "invalid" as "auto";
    save();
    assert.throws(() => loadWorkspaceConfig(path), /discovery.mode/);
    body.discovery!.mode = "auto";
    body.discovery!.cwd = body.lead.cwd;
    save();
    assert.throws(() => loadWorkspaceConfig(path), /thư mục riêng/);
    body.discovery!.cwd = join(root, "discovery");
    body.discovery!.model = "bad model";
    save();
    assert.throws(() => loadWorkspaceConfig(path), /discovery.model/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("Discovery App Settings override workspace config per field when the Discovery turn starts", async () => {
  const ctx = fixture();
  const captured: Array<{ role: string; model?: string; effort?: string }> = [];
  const runtime: AgentRuntime = {
    async run(session, _cwd, _prompt, hooks, selection) {
      hooks.onThread(session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      captured.push({ role: session.role, model: selection?.model, effort: selection?.effort });
      return session.role === "discovery" ? "Sơ bộ: module API" : "Đã nhận báo cáo";
    }
  };
  try {
    const task = ctx.store.createConversation("Khảo sát API", undefined, true);
    ctx.store.updateSettings({
      lead: { model: "lead-model", effort: "medium" },
      discovery: { model: "ui-model" },
      peer: { model: "peer-model" }
    });
    new Coordinator(config, ctx.store, runtime);
    await until(() => ctx.store.snapshot().messages.some(m => m.text === "Đã nhận báo cáo"));
    assert.equal(ctx.store.conversation(task.id)?.status, "active");
    assert.deepEqual(captured, [
      { role: "discovery", model: "ui-model", effort: "low" },
      { role: "lead", model: "lead-model", effort: "medium" }
    ]);
    assert.equal(ctx.store.queued().length, 0);
  } finally { ctx.cleanup(); }
});
