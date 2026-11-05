import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, WorkspaceConfig } from "@aacc/contracts";
import { CoordinationStore } from "./coordination-store.js";
import { Coordinator } from "./coordinator.js";
import type { AgentRuntime } from "./codex-runtime.js";

const config: WorkspaceConfig = {
  lead: { cwd: "/tmp/agent-workspace", instructions: "Điều phối" },
  modules: [{ id: "web", label: "Web", path: "/tmp/module-web" }]
};
async function until(check: () => boolean, timeout = 4000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for coordination");
    await new Promise(resolve => setTimeout(resolve, 8));
  }
}
test("User -> Lead -> Peer -> Lead follow-up -> same Peer Thread -> Lead finish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-coordinator-"));
  const store = new CoordinationStore(dir);
  let leadCalls = 0;
  const peerInputs: Array<{ threadId?: string; cwd: string; prompt: string }> = [];
  const runtime: AgentRuntime = {
    async run(session, cwd, prompt, hooks) {
      hooks.onThread(session.threadId ?? session.id + "-thread");
      hooks.onTurn(session.id + "-turn-" + (session.role === "lead" ? ++leadCalls : peerInputs.length + 1));
      if (session.role === "lead") {
        if (leadCalls === 1) return JSON.stringify({ reply: "Đã giao Web", commands: [
          { type: "spawn_peer", moduleId: "web", label: "README Web",
            message: "Tạo README.md trong module Web" }
        ] });
        if (leadCalls === 2) {
          const peer = store.snapshot().sessions.find(s => s.role === "peer")!;
          return JSON.stringify({ commands: [
            { type: "send_peer", sessionId: peer.id, message: "Bổ sung cách chạy build" }
          ] });
        }
        return JSON.stringify({ reply: "Đã xem kết quả", commands: [
          { type: "finish", summary: "README.md đã hoàn thành" }
        ] });
      }
      peerInputs.push({ threadId: session.threadId, cwd, prompt });
      return peerInputs.length === 1
        ? "Đã tạo README.md nhưng còn thiếu build command"
        : "Đã thêm npm run build vào README.md";
    }
  };
  try {
    new Coordinator(config, store, runtime);
    const conversation = store.createConversation("Xem module Web và tạo README.md");
    await until(() => store.conversation(conversation.id)?.status === "finished");
    const snapshot = store.snapshot();
    const peer = snapshot.sessions.find(s => s.role === "peer")!;
    assert.ok(peer);
    assert.equal(peer.moduleId, "web");
    assert.equal(peer.threadId, peer.id + "-thread");
    assert.equal(peerInputs.length, 2);
    assert.equal(peerInputs[0].threadId, undefined);
    assert.equal(peerInputs[1].threadId, peer.id + "-thread",
      "Follow-up must resume existing Codex Thread");
    assert.ok(peerInputs.every(item => item.cwd === "/tmp/module-web"));
    assert.equal(leadCalls, 3);
    assert.equal(snapshot.deliveries.filter(d => d.status === "completed").length, 5);
    assert.ok(snapshot.messages.some(m => m.from === "peer" && m.to === "lead"));
    assert.ok(snapshot.messages.some(m => m.from === "lead" && m.to === "user"));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Peer error automatically wakes Lead, without requiring user approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-coord-errors-"));
  const store = new CoordinationStore(dir);
  let leadCalls = 0;
  const runtime: AgentRuntime = {
    async run(session, _cwd, _prompt, hooks) {
      hooks.onThread(session.id);
      hooks.onTurn(session.id + "-turn");
      if (session.role === "peer") throw new Error("Module dependency unavailable");
      leadCalls++;
      return leadCalls === 1
        ? JSON.stringify({ commands: [{ type: "spawn_peer", moduleId: "web", message: "Do work" }] })
        : JSON.stringify({ reply: "Peer báo blocker, cần xử lý", commands: [] });
    }
  };
  try {
    new Coordinator(config, store, runtime);
    const conversation = store.createConversation("Giao Peer thử nghiệm");
    await until(() => leadCalls >= 2);
    const peer = store.snapshot().sessions.find(s => s.role === "peer")!;
    assert.equal(peer.status, "interrupted");
    assert.ok(store.snapshot().messages.some(m => m.to === "lead" &&
      m.text.includes("Module dependency unavailable")));
    assert.ok(store.snapshot().messages.some(m => m.from === "lead" &&
      m.to === "user" && m.text.includes("blocker")));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Two Peer sessions in the same module can execute concurrently in direct cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-parallel-"));
  const store = new CoordinationStore(dir);
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const inputs: Array<{ sessionId: string; cwd: string }> = [];
  const runtime: AgentRuntime = {
    async run(session, cwd, _prompt, hooks) {
      hooks.onThread(session.threadId ?? session.id);
      hooks.onTurn(session.id);
      if (session.role === "lead") {
        if (store.snapshot().sessions.filter(s => s.role === "peer").length === 0) {
          return JSON.stringify({ commands: [
            { type: "spawn_peer", moduleId: "web", label: "Peer A", message: "Task A" },
            { type: "spawn_peer", moduleId: "web", label: "Peer B", message: "Task B" }
          ] });
        }
        return JSON.stringify({ reply: "Đã nhận kết quả", commands: [] });
      }
      started++;
      inputs.push({ sessionId: session.id, cwd });
      await gate;
      return "Completed in direct source module";
    }
  };
  try {
    new Coordinator(config, store, runtime, 4);
    store.createConversation("Create two Web tasks");
    await until(() => started === 2);
    assert.equal(new Set(inputs.map(i => i.sessionId)).size, 2);
    assert.deepEqual(inputs.map(i => i.cwd), [config.modules[0].path, config.modules[0].path]);
    release();
    await until(() => store.snapshot().messages.filter(m => m.from === "peer").length === 2);
  } finally {
    release?.(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("E2E regression: malformed Lead Todo API JSON retries and really spawns Peer Web", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-todo-routing-"));
  const store = new CoordinationStore(dir);
  const fullstack: WorkspaceConfig = {
    lead: { cwd: "/tmp/agent-workspace", instructions: "Điều phối" },
    modules: [
      { id: "api", label: "API", path: "/tmp/module-api" },
      { id: "web", label: "Web", path: "/tmp/module-web" }
    ]
  };
  let leadTurns = 0;
  let peerTurns = 0;
  const runtime: AgentRuntime = {
    async run(session, cwd, prompt, hooks) {
      hooks.onThread(session.threadId ?? session.id + "-thread");
      hooks.onTurn(session.id + "-turn-" + (leadTurns + peerTurns));
      if (session.role === "lead") {
        leadTurns++;
        if (leadTurns === 1) {
          // Inline API example has unescaped quotes, as in the observed Todo E2E.
          return '{"reply":"Backend API done","commands":[{"type":"spawn_peer",' +
            '"moduleId":"web","label":"Todo Web",' +
            '"message":"GET /api/todos returns {"todos":[]}"}]}';
        }
        if (leadTurns === 2) {
          assert.equal(session.threadId, session.id + "-thread",
            "Format correction must resume the same Lead thread");
          assert.match(prompt, /Lệnh điều phối trước không parse được/);
          return JSON.stringify({
            reply: "Đang giao Peer Web",
            commands: [{ type: "spawn_peer", moduleId: "web", label: "Todo Web",
              message: 'GET /api/todos returns {"todos":[]}; build Todo UI' }]
          });
        }
        return JSON.stringify({ commands: [{ type: "finish", summary: "Web đã hoàn thành" }] });
      }
      peerTurns++;
      assert.equal(session.moduleId, "web");
      assert.equal(cwd, "/tmp/module-web");
      return "Đã tạo giao diện Todo";
    }
  };
  try {
    new Coordinator(fullstack, store, runtime);
    const conversation = store.createConversation("Tạo Todo API và Web");
    try {
      await until(() => store.conversation(conversation.id)?.status === "finished", 10000);
    } catch (error) {
      throw new Error("E2E Todo state: " + JSON.stringify({
        leadTurns, peerTurns, conversation: store.conversation(conversation.id),
        deliveries: store.snapshot().deliveries.map(d => ({ status: d.status, error: d.error })),
        messages: store.snapshot().messages.map(m => ({ from: m.from, to: m.to, text: m.text.slice(0, 250) }))
      }), { cause: error });
    }
    const snap = store.snapshot();
    assert.equal(leadTurns, 3);
    assert.equal(peerTurns, 1);
    assert.equal(snap.sessions.filter(s => s.role === "peer" && s.moduleId === "web").length, 1);
    assert.ok(snap.messages.some(m => m.from === "lead" && m.to === "peer" &&
      m.text.includes('{"todos":[]}')));
    assert.ok(snap.messages.some(m => m.from === "peer" && m.to === "lead"));
    assert.ok(!snap.messages.some(m => m.from === "lead" && m.to === "user" &&
      m.text.includes('"commands"')), "Malformed routing JSON must not be shown as a Lead reply");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Persistent malformed action reports failure to User, no silent empty commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-routing-errors-"));
  const store = new CoordinationStore(dir);
  let leadTurns = 0;
  const runtime: AgentRuntime = {
    async run(session, _cwd, _prompt, hooks) {
      leadTurns++;
      hooks.onThread(session.threadId ?? session.id + "-thread");
      hooks.onTurn(session.id + "-turn-" + leadTurns);
      return '{"commands":[{"type":"spawn_peer","moduleId":"web","message":"GET {"todos":[]}"}]}';
    }
  };
  try {
    new Coordinator(config, store, runtime);
    const conversation = store.createConversation("Tạo Todo");
    await until(() => store.snapshot().deliveries.some(d =>
      d.conversationId === conversation.id && d.status === "interrupted"));
    assert.equal(leadTurns, 2, "Retry is bounded to one repair turn");
    assert.equal(store.snapshot().sessions.filter(s => s.role === "peer").length, 0);
    assert.ok(store.snapshot().messages.some(m => m.from === "system" && m.to === "user" &&
      m.text.includes("lệnh điều phối")));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Lead tool dispatch is not duplicated when final prose echoes the same JSON command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-tool-echo-"));
  const store = new CoordinationStore(dir);
  let turns = 0;
  const cmd = { type: "spawn_peer" as const, moduleId: "web",
    message: 'GET /api/todos => {"todos":[]}', label: "Todo Web" };
  const runtime: AgentRuntime = {
    async run(session, cwd, _prompt, hooks) {
      hooks.onThread(session.threadId ?? session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      if (session.role === "peer") return "Todo UI đã triển khai";
      turns++;
      if (turns === 1) {
        hooks.onToolProtocol?.("dynamic");
        assert.ok(hooks.onLeadTool);
        const result = await hooks.onLeadTool("lead-thread:call-1", cmd);
        assert.match(result, /sessionId=/);
        hooks.onToolUsed?.();
        // This echoed JSON must not create a second Peer.
        return JSON.stringify({ reply: "Đã giao Peer Web",
          commands: [cmd] });
      }
      return JSON.stringify({ reply: "Đã nhận kết quả Web",
        commands: [{ type: "finish", summary: "Todo hoàn thành" }] });
    }
  };
  try {
    new Coordinator(config, store, runtime);
    const c = store.createConversation("Todo");
    await until(() => store.conversation(c.id)?.status === "finished");
    const snapshot = store.snapshot();
    assert.equal(snapshot.sessions.filter(s => s.role === "peer").length, 1);
    assert.equal(snapshot.messages.filter(m => m.from === "lead" && m.to === "peer").length, 1);
    assert.equal(snapshot.messages.filter(m => m.from === "peer" && m.to === "lead").length, 1);
    assert.equal(snapshot.sessions.find(s => s.role === "lead")?.toolProtocol, "dynamic");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
