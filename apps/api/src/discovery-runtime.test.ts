import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@aacc/contracts";
import { CodexClient } from "./codex-client.js";
import { CodexAgentRuntime } from "./codex-runtime.js";

const code = [
  'process.stdin.setEncoding("utf8");let buf="";let start;',
  'const send=m=>console.log(JSON.stringify(m));',
  'process.stdin.on("data",chunk=>{buf+=chunk;let i;',
  'while((i=buf.indexOf(String.fromCharCode(10)))>=0){',
  'const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line)continue;',
  'const m=JSON.parse(line);',
  'if(m.method==="initialize")send({id:m.id,result:{}});',
  'if(m.method==="thread/start"){',
  'start=m.params;',
  'if(m.params.dynamicTools || m.params.permissions || m.params.config)',
  'send({id:m.id,error:{message:"Discovery/Peer must not have custom permissions or tools"}});',
  'else send({id:m.id,result:{thread:{id:"worker-thread"}}});}',
  'if(m.method==="turn/start"){',
  'send({id:m.id,result:{turn:{id:"turn-1",status:"inProgress"}}});',
  'send({method:"item/completed",params:{threadId:"worker-thread",turnId:"turn-1",',
  'item:{type:"agentMessage",text:JSON.stringify({thread:start,turn:m.params})}}});',
  'send({method:"turn/completed",params:{threadId:"worker-thread",',
  'turn:{id:"turn-1",status:"completed"}}});',
  '}}});'
].join("");

const at = "2026-11-05T00:00:00Z";
function session(role: "peer" | "discovery"): AgentSession {
  return { id: role, conversationId: "task", role, label: role, status: "idle",
    createdAt: at, updatedAt: at, ...(role === "peer" ? { moduleId: "api" } : {}) };
}
async function run(role: "peer" | "discovery", securityMode?: string) {
  const previous = process.env.CODEX_SECURITY_MODE;
  if (securityMode) process.env.CODEX_SECURITY_MODE = securityMode;
  else delete process.env.CODEX_SECURITY_MODE;
  const client = new CodexClient(process.execPath, ["-e", code]);
  const s = session(role);
  try {
    const result = await new CodexAgentRuntime(client).run(s,
      role === "discovery" ? "/work/discovery" : "/work/api", "Khảo sát sơ bộ", {
        onThread: id => { s.threadId = id; }, onTurn: id => { s.turnId = id; }
      }, { model: "test-model", effort: "low" },
      role === "discovery" ? ["/work/discovery", "/work/api", "/work/web"] : undefined);
    return JSON.parse(result) as {
      thread: { cwd: string; approvalPolicy: string; sandbox: string;
        runtimeWorkspaceRoots?: string[]; dynamicTools?: unknown; permissions?: string },
      turn: { approvalPolicy: string; sandboxPolicy: {
        type: string; writableRoots?: string[]; networkAccess?: boolean
      }; permissions?: string; model: string; effort: string }
    };
  } finally {
    client.stop();
    if (previous === undefined) delete process.env.CODEX_SECURITY_MODE;
    else process.env.CODEX_SECURITY_MODE = previous;
  }
}

test("Discovery and Peer share full-access runtime policy; Discovery adds module workspace roots", async () => {
  const discovery = await run("discovery");
  const peer = await run("peer");
  assert.equal(discovery.thread.cwd, "/work/discovery");
  assert.deepEqual(discovery.thread.runtimeWorkspaceRoots,
    ["/work/discovery", "/work/api", "/work/web"]);
  assert.equal(peer.thread.runtimeWorkspaceRoots, undefined);
  assert.equal(discovery.thread.sandbox, peer.thread.sandbox);
  assert.equal(discovery.thread.approvalPolicy, peer.thread.approvalPolicy);
  assert.equal(discovery.thread.sandbox, "danger-full-access");
  assert.equal(discovery.turn.sandboxPolicy.type, peer.turn.sandboxPolicy.type);
  assert.equal(discovery.turn.sandboxPolicy.type, "dangerFullAccess");
  assert.equal(discovery.turn.permissions, undefined);
  assert.equal(discovery.thread.permissions, undefined);
});

test("Discovery and Peer share sandbox runtime policy; Discovery can access multiple modules", async () => {
  const discovery = await run("discovery", "sandbox");
  const peer = await run("peer", "sandbox");
  assert.equal(discovery.thread.sandbox, peer.thread.sandbox);
  assert.equal(discovery.thread.sandbox, "workspace-write");
  assert.equal(discovery.thread.approvalPolicy, "on-request");
  assert.equal(discovery.turn.sandboxPolicy.type, "workspaceWrite");
  assert.equal(discovery.turn.sandboxPolicy.networkAccess, false);
  assert.deepEqual(discovery.turn.sandboxPolicy.writableRoots,
    ["/work/discovery", "/work/api", "/work/web"]);
  assert.deepEqual(peer.turn.sandboxPolicy.writableRoots, ["/work/api"]);
  assert.equal(discovery.turn.approvalPolicy, peer.turn.approvalPolicy);
  assert.equal(discovery.turn.permissions, undefined);
});
