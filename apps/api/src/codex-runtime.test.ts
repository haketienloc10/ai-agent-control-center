import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@aacc/contracts";
import { CodexClient } from "./codex-client.js";
import { CodexAgentRuntime } from "./codex-runtime.js";

const fakeServer = [
  'process.stdin.setEncoding("utf8"); let buffer=""; let seq=0; let threadModel;',
  'const send=m=>console.log(JSON.stringify(m));',
  'process.stdin.on("data",chunk=>{buffer+=chunk;let index;',
  'while((index=buffer.indexOf(String.fromCharCode(10)))>=0){',
  'const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;',
  'const m=JSON.parse(line);',
  'if(m.method==="initialize")send({id:m.id,result:{}});',
  'if(m.method==="thread/start"){threadModel=m.params.model;const id="thread-"+(++seq);send({id:m.id,result:{thread:{id}}});}',
  'if(m.method==="thread/resume")send({id:m.id,result:{thread:{id:m.params.threadId}}});',
  'if(m.method==="turn/start"){const id="turn-"+(++seq);',
  'send({id:m.id,result:{turn:{id}}});',
  'send({method:"item/completed",params:{threadId:m.params.threadId,',
  'item:{type:"agentMessage",text:JSON.stringify({',
  'threadId:m.params.threadId,cwd:m.params.cwd,threadModel,turnModel:m.params.model,effort:m.params.effort,',
  'sandboxPolicy:m.params.sandboxPolicy})}}});',
  'send({method:"turn/completed",params:{threadId:m.params.threadId,turn:{id,status:"completed"}}});',
  '}}});'
].join("");
const time = "2026-11-03T00:00:00Z";
function session(role: "lead" | "peer"): AgentSession {
  return { id: role, role, conversationId: "c1", label: role, status: "idle",
    ...(role === "peer" ? { moduleId: "web" } : {}),
    createdAt: time, updatedAt: time };
}
test("Codex runtime starts once, resumes same thread, Lead writes only its workspace, Peer direct YOLO", async () => {
  const before = process.env.CODEX_SECURITY_MODE;
  delete process.env.CODEX_SECURITY_MODE;
  const client = new CodexClient(process.execPath, ["-e", fakeServer]);
  const runtime = new CodexAgentRuntime(client);
  try {
    const lead = session("lead");
    const first = JSON.parse(await runtime.run(lead, "/agent/workspace", "Coordinate", {
      onThread: id => { lead.threadId = id; },
      onTurn: id => { lead.turnId = id; }
    }, { model: "lead-default", effort: "high" })) as { threadId: string; cwd: string;
      threadModel: string; turnModel: string; effort: string; sandboxPolicy: { type: string } };
    assert.equal(first.cwd, "/agent/workspace");
    assert.equal(first.threadModel, "lead-default");
    assert.equal(first.turnModel, "lead-default");
    assert.equal(first.effort, "high");
    assert.equal(first.sandboxPolicy.type, "workspaceWrite");
    assert.deepEqual((first.sandboxPolicy as unknown as { writableRoots: string[] }).writableRoots,
      ["/agent/workspace"]);
    const peer = session("peer");
    const result1 = JSON.parse(await runtime.run(peer, "/modules/web", "Create README", {
      onThread: id => { peer.threadId = id; },
      onTurn: id => { peer.turnId = id; }
    }, { model: "peer-frozen", effort: "low" })) as { threadId: string; cwd: string;
      threadModel: string; turnModel: string; effort: string; sandboxPolicy: { type: string } };
    assert.equal(result1.cwd, "/modules/web");
    assert.equal(result1.threadModel, "peer-frozen");
    assert.equal(result1.turnModel, "peer-frozen");
    assert.equal(result1.effort, "low");
    assert.equal(result1.sandboxPolicy.type, "dangerFullAccess");
    const result2 = JSON.parse(await runtime.run(peer, "/modules/web", "Add build", {
      onThread: id => { peer.threadId = id; },
      onTurn: id => { peer.turnId = id; }
    }, { model: "peer-frozen", effort: "low" })) as { threadId: string; cwd: string;
      threadModel: string; turnModel: string; effort: string; sandboxPolicy: { type: string } };
    assert.equal(result2.threadId, result1.threadId);
    assert.equal(result2.turnModel, "peer-frozen");
    assert.equal(result2.effort, "low");
    assert.equal(result2.cwd, "/modules/web");
  } finally {
    client.stop();
    if (before === undefined) delete process.env.CODEX_SECURITY_MODE;
    else process.env.CODEX_SECURITY_MODE = before;
  }
});

const instructionServer = fakeServer
  .replace("let threadModel;", "let threadModel; let instr;")
  .replace("threadModel=m.params.model;", "threadModel=m.params.model;instr=m.params.developerInstructions;")
  .replace('if(m.method==="thread/resume")send(', 'if(m.method==="thread/resume"){instr=m.params.developerInstructions;}if(m.method==="thread/resume")send(')
  .replace("threadId:m.params.threadId,cwd:m.params.cwd,", "threadId:m.params.threadId,cwd:m.params.cwd,instr,prompt:m.params.input[0].text,");
test("Codex runtime sends role rules as developerInstructions on thread/start and thread/resume, not in the turn input", async () => {
  const client = new CodexClient(process.execPath, ["-e", instructionServer]);
  const runtime = new CodexAgentRuntime(client);
  try {
    const peer = session("peer");
    const hooks = { onThread: (id: string) => { peer.threadId = id; }, onTurn: () => {} };
    const first = JSON.parse(await runtime.run(peer, "/modules/web", "Turn 1 data", hooks,
      {}, undefined, "ROLE RULES v1")) as { instr: string; prompt: string };
    assert.equal(first.instr, "ROLE RULES v1");
    assert.equal(first.prompt, "Turn 1 data");
    const second = JSON.parse(await runtime.run(peer, "/modules/web", "Turn 2 data", hooks,
      {}, undefined, "ROLE RULES v2")) as { instr: string; prompt: string };
    assert.equal(second.instr, "ROLE RULES v2", "resume must refresh rules for existing threads");
    assert.equal(second.prompt, "Turn 2 data");
  } finally { client.stop(); }
});
