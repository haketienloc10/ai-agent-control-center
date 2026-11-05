import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@aacc/contracts";
import { CoordinationStore } from "./coordination-store.js";
import { Coordinator } from "./coordinator.js";
import type { AgentRuntime } from "./codex-runtime.js";

const config: WorkspaceConfig = {
  lead: { cwd: "/tmp/agent-workspace", instructions: "Điều phối" },
  modules: [{ id: "web", label: "Web", path: "/tmp/module-web" }]
};
async function until(check: () => boolean, timeout = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for coordination");
    await new Promise(resolve => setTimeout(resolve, 8));
  }
}
test("Lead returns to idle after dispatch; only Peer completion starts another Lead turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-event-lead-"));
  const store = new CoordinationStore(dir);
  let leadTurns = 0, peerTurns = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime: AgentRuntime = {
    async run(session, cwd, prompt, hooks) {
      hooks.onThread(session.threadId ?? session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      if (session.role === "lead") {
        leadTurns++;
        if (leadTurns === 1) {
          assert.match(prompt, /không gọi send_peer chỉ để hỏi trạng thái/);
          await hooks.onLeadTool!("lead:spawn", {
            type: "spawn_peer", moduleId: "web", message: "Create Todo UI"
          });
          return "Đã giao Web";
        }
        assert.match(prompt, /Todo UI done/);
        await hooks.onLeadTool!("lead:finish", { type: "finish", summary: "Todo hoàn thành" });
        return "Duplicate finish text";
      }
      peerTurns++;
      assert.equal(cwd, "/tmp/module-web");
      await gate;
      return "Todo UI done";
    }
  };
  try {
    new Coordinator(config, store, runtime);
    const c = store.createConversation("Build Todo");
    await until(() => peerTurns === 1 && store.session(c.leadSessionId)?.status === "idle");
    assert.equal(leadTurns, 1, "Lead must not poll Peer while it is running");
    assert.equal(store.conversation(c.id)?.status, "active");
    assert.equal(store.queued().filter(d => d.sessionId === c.leadSessionId).length, 0);
    release();
    await until(() => store.conversation(c.id)?.status === "finished" &&
      store.session(c.leadSessionId)?.status === "idle");
    assert.equal(leadTurns, 2);
    assert.equal(store.snapshot().messages.filter(m => m.text === "Todo hoàn thành").length, 1);
    assert.ok(!store.snapshot().messages.some(m => m.text === "Duplicate finish text"));
  } finally { release?.(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("Peer error emits an event; does not create polling loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-event-error-"));
  const store = new CoordinationStore(dir);
  let leadTurns = 0;
  const runtime: AgentRuntime = {
    async run(session, _cwd, prompt, hooks) {
      hooks.onThread(session.threadId ?? session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      if (session.role === "peer") throw new Error("Dependency unavailable");
      leadTurns++;
      if (leadTurns === 1) {
        await hooks.onLeadTool!("lead:spawn", {
          type: "spawn_peer", moduleId: "web", message: "Implement UI"
        });
        return "Đã giao";
      }
      assert.match(prompt, /Dependency unavailable/);
      return "Peer gặp blocker, cần xử lý";
    }
  };
  try {
    new Coordinator(config, store, runtime);
    const c = store.createConversation("Test error");
    await until(() => leadTurns === 2 && store.session(c.leadSessionId)?.status === "idle");
    assert.equal(store.snapshot().sessions.find(s => s.role === "peer")?.status, "interrupted");
    assert.equal(leadTurns, 2);
    assert.equal(store.queued().filter(d => d.sessionId === c.leadSessionId).length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("Two Peers run concurrently; Lead stays idle until event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-parallel-"));
  const store = new CoordinationStore(dir);
  let peersStarted = 0, leadTurns = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime: AgentRuntime = {
    async run(session, cwd, _prompt, hooks) {
      hooks.onThread(session.threadId ?? session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      if (session.role === "lead") {
        leadTurns++;
        if (leadTurns === 1) {
          await hooks.onLeadTool!("lead:a",
            { type: "spawn_peer", moduleId: "web", message: "Task A" });
          await hooks.onLeadTool!("lead:b",
            { type: "spawn_peer", moduleId: "web", message: "Task B" });
        }
        return "";
      }
      peersStarted++;
      assert.equal(cwd, config.modules[0].path);
      await gate;
      return "Completed " + session.id;
    }
  };
  try {
    new Coordinator(config, store, runtime);
    const c = store.createConversation("Parallel work");
    await until(() => peersStarted === 2 && store.session(c.leadSessionId)?.status === "idle");
    assert.equal(leadTurns, 1);
    assert.equal(store.queued().filter(d => d.sessionId === c.leadSessionId).length, 0);
    release();
    await until(() => store.snapshot().messages.filter(m => m.from === "peer").length === 2);
    assert.equal(store.snapshot().sessions.filter(s => s.role === "peer").length, 2);
  } finally { release?.(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
