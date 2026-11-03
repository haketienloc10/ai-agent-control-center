import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@aacc/contracts";
import { CodexClient } from "./codex-client.js";
import { CodexAgentRuntime } from "./codex-runtime.js";

const fakeServer = [
  'process.stdin.setEncoding("utf8"); let buffer=""; let seq=0;',
  'const send=m=>console.log(JSON.stringify(m));',
  'process.stdin.on("data",chunk=>{buffer+=chunk;let index;',
  'while((index=buffer.indexOf(String.fromCharCode(10)))>=0){',
  'const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;',
  'const m=JSON.parse(line);',
  'if(m.method==="initialize")send({id:m.id,result:{}});',
  'if(m.method==="thread/start"){const id="thread-"+(++seq);send({id:m.id,result:{thread:{id}}});}',
  'if(m.method==="thread/resume")send({id:m.id,result:{thread:{id:m.params.threadId}}});',
  'if(m.method==="turn/start"){const id="turn-"+(++seq);',
  'send({id:m.id,result:{turn:{id}}});',
  'send({method:"item/completed",params:{threadId:m.params.threadId,',
  'item:{type:"agentMessage",text:JSON.stringify({',
  'threadId:m.params.threadId,cwd:m.params.cwd,',
  'sandboxPolicy:m.params.sandboxPolicy})}}});',
  'send({method:"turn/completed",params:{threadId:m.params.threadId,turn:{id,status:"completed"}}});',
  '}});'
].join("");
const time = "2026-11-03T00:00:00Z";
function session(role: "lead" | "peer"): AgentSession {
  return { id: role, role, conversationId: "c1", label: role, status: "idle",
    ...(role === "peer" ? { moduleId: "web" } : {}),
    createdAt: time, updatedAt: time };
}
test("Codex runtime starts once, resumes same thread, Lead read-only, Peer direct YOLO", async () => {
  const before = process.env.CODEX_SECURITY_MODE;
  delete process.env.CODEX_SECURITY_MODE;
  const client = new CodexClient(process.execPath, ["-e", fakeServer]);
  const runtime = new CodexAgentRuntime(client);
  try {
    const lead = session("lead");
    const first = JSON.parse(await runtime.run(lead, "/agent/workspace", "Coordinate", {
      onThread: id => { lead.threadId = id; },
      onTurn: id => { lead.turnId = id; }
    })) as { threadId: string; cwd: string; sandboxPolicy: { type: string } };
    assert.equal(first.cwd, "/agent/workspace");
    assert.equal(first.sandboxPolicy.type, "readOnly");
    const peer = session("peer");
    const result1 = JSON.parse(await runtime.run(peer, "/modules/web", "Create README", {
      onThread: id => { peer.threadId = id; },
      onTurn: id => { peer.turnId = id; }
    })) as { threadId: string; cwd: string; sandboxPolicy: { type: string } };
    assert.equal(result1.cwd, "/modules/web");
    assert.equal(result1.sandboxPolicy.type, "dangerFullAccess");
    const result2 = JSON.parse(await runtime.run(peer, "/modules/web", "Add build", {
      onThread: id => { peer.threadId = id; },
      onTurn: id => { peer.turnId = id; }
    })) as { threadId: string; cwd: string; sandboxPolicy: { type: string } };
    assert.equal(result2.threadId, result1.threadId);
    assert.equal(result2.cwd, "/modules/web");
  } finally {
    client.stop();
    if (before === undefined) delete process.env.CODEX_SECURITY_MODE;
    else process.env.CODEX_SECURITY_MODE = before;
  }
});
