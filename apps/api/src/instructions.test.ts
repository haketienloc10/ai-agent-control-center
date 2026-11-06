import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@aacc/contracts";
import { CoordinationStore } from "./coordination-store.js";
import { Coordinator } from "./coordinator.js";
import type { AgentRuntime } from "./codex-runtime.js";
import { roleInstructions } from "./instructions.js";

test("Role instructions are optional files: missing or empty means no rules, other errors surface", () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-instructions-"));
  try {
    assert.equal(roleInstructions(dir, "lead"), undefined);
    writeFileSync(join(dir, "peer.md"), "  \n");
    assert.equal(roleInstructions(dir, "peer"), undefined);
    writeFileSync(join(dir, "discovery.md"), "Quy tắc Discovery\n");
    assert.equal(roleInstructions(dir, "discovery"), "Quy tắc Discovery");
    mkdirSync(join(dir, "lead.md"));
    assert.throws(() => roleInstructions(dir, "lead"), /EISDIR/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Coordinator sends file rules plus session data, and only data when the role file is absent", async () => {
  const data = mkdtempSync(join(tmpdir(), "aacc-instructions-store-"));
  const dir = mkdtempSync(join(tmpdir(), "aacc-instructions-dir-"));
  writeFileSync(join(dir, "peer.md"), "PEER RULES FROM FILE");
  const config: WorkspaceConfig = {
    lead: { cwd: "/repo/lead" },
    modules: [{ id: "web", label: "Web", path: "/repo/web" }]
  };
  const store = new CoordinationStore(data);
  const seen: Record<string, string | undefined> = {};
  const runtime: AgentRuntime = {
    async run(session, _cwd, _prompt, hooks, _selection, _roots, instructions) {
      hooks.onThread(session.id + "-thread");
      hooks.onTurn(session.id + "-turn");
      seen[session.role] ??= instructions;
      if (session.role === "lead" && !seen.peer) {
        await hooks.onLeadTool!("spawn", {
          type: "assign_module", moduleId: "web", message: "Kiểm tra", expectedResult: "Báo cáo"
        });
      }
      return "ok";
    }
  };
  try {
    new Coordinator(config, store, runtime, 4, dir);
    store.createConversation("Todo");
    const start = Date.now();
    while (!seen.peer) {
      if (Date.now() - start > 5000) throw new Error("Peer did not run");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(seen.lead, 'LEAD_WORKSPACE: /repo/lead\n\nMODULES: [{"id":"web","label":"Web","path":"/repo/web"}]\n\nDISCOVERY_ENABLED: false');
    assert.equal(seen.peer, "PEER RULES FROM FILE\n\nMODULE: web\n\nWORKSPACE MODULE: /repo/web");
  } finally {
    store.close();
    rmSync(data, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
