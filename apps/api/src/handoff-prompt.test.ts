import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@aacc/contracts";
import { CoordinationStore } from "./coordination-store.js";
import { Coordinator } from "./coordinator.js";
import type { AgentRuntime } from "./codex-runtime.js";

test("Trace SQLite giữ đúng prompt runtime của Discovery và hai lượt Peer sau restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-handoff-"));
  const config: WorkspaceConfig = {
    lead: { cwd: dir }, discovery: { cwd: dir },
    modules: [{ id: "api", label: "API", path: dir }]
  };
  let store = new CoordinationStore(dir);
  let leadTurns = 0;
  const captured = new Map<string, string>();
  const runtime: AgentRuntime = {
    async run(session, _cwd, prompt, hooks) {
      hooks.onThread(session.threadId ?? session.id + "-thread");
      if (session.role === "lead") {
        leadTurns++;
        if (leadTurns === 1) {
          await hooks.onLeadTool!("survey", { type: "spawn_discovery",
            message: "Khảo sát **API**\n  Giữ khoảng trắng", expectedResult: "Báo cáo" });
        } else if (leadTurns < 4) {
          await hooks.onLeadTool!("assignment-" + leadTurns, { type: "assign_module", moduleId: "api",
            message: leadTurns === 2 ? "Lượt đầu **triển khai**" : "Lượt sau <kiểm tra>",
            expectedResult: "Bằng chứng\nnguyên văn" });
        } else {
          await hooks.onLeadTool!("finish", { type: "finish" });
        }
        return "Đã điều phối";
      }
      const delivery = store.snapshot().deliveries.find(d => d.sessionId === session.id && d.status === "running")!;
      const message = store.snapshot().messages.find(m => m.id === delivery.messageId)!;
      assert.equal(message.handoffPrompt, prompt, "Bản ghi tồn tại trước khi gọi runtime");
      assert.ok(prompt.includes(message.text));
      captured.set(message.id, prompt);
      assert.equal(store.recordHandoffPrompt(delivery.id, "Không được ghi đè"), prompt);
      return "Kết quả " + captured.size;
    }
  };
  try {
    new Coordinator(config, store, runtime);
    const conversation = store.createConversation("Yêu cầu gốc");
    const deadline = Date.now() + 4000;
    while (store.session(conversation.leadSessionId)?.status !== "idle" ||
      store.conversation(conversation.id)?.status !== "finished") {
      if (Date.now() > deadline) throw new Error("Timed out waiting for handoffs");
      await new Promise(resolve => setTimeout(resolve, 8));
    }
    assert.equal(captured.size, 3);
    const prompts = [...captured.values()];
    assert.match(prompts[0], /LEAD_MESSAGE: Khảo sát \*\*API\*\*/);
    assert.match(prompts[1], /ORIGINAL_USER_REQUEST:\nYêu cầu gốc/);
    assert.match(prompts[1], /WORK:\nLượt đầu \*\*triển khai\*\*/);
    assert.match(prompts[2], /CONTINUES: /);
    assert.doesNotMatch(prompts[2], /ORIGINAL_USER_REQUEST/);
    assert.match(prompts[2], /WORK:\nLượt sau <kiểm tra>/);
    store.close();
    store = new CoordinationStore(dir);
    for (const [id, prompt] of captured) {
      assert.equal(store.snapshot().messages.find(m => m.id === id)?.handoffPrompt, prompt);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
