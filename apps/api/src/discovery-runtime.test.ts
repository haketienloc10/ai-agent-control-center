import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@aacc/contracts";
import { CodexClient } from "./codex-client.js";
import { CodexAgentRuntime } from "./codex-runtime.js";

const server = [
  'process.stdin.setEncoding("utf8");let buf="";',
  'const send=m=>console.log(JSON.stringify(m));',
  'process.stdin.on("data",chunk=>{buf+=chunk;let i;',
  'while((i=buf.indexOf(String.fromCharCode(10)))>=0){',
  'const s=buf.slice(0,i);buf=buf.slice(i+1);if(!s)continue;',
  'const m=JSON.parse(s);',
  'if(m.method==="initialize")send({id:m.id,result:{}});',
  'if(m.method==="thread/start"){',
  'if(m.params.dynamicTools)send({id:m.id,error:{message:"Discovery must not have routing tools"}});',
  'else send({id:m.id,result:{thread:{id:"discovery-thread"}}});}',
  'if(m.method==="turn/start"){',
  'const p=m.params.sandboxPolicy;',
  'send({id:m.id,result:{turn:{id:"turn-1",status:"inProgress"}}});',
  'send({method:"item/completed",params:{threadId:"discovery-thread",turnId:"turn-1",',
  'item:{type:"agentMessage",text:JSON.stringify({policy:p,',
  'approval:m.params.approvalPolicy,cwd:m.params.cwd})}}});',
  'send({method:"turn/completed",params:{threadId:"discovery-thread",',
  'turn:{id:"turn-1",status:"completed"}}});',
  '}}});'
].join("");

test("Discovery app-server turn uses its own thread, no Lead dynamic tools, restricted read-only roots", async () => {
  const client = new CodexClient(process.execPath, ["-e", server]);
  const runtime = new CodexAgentRuntime(client);
  const at = "2026-11-05T00:00:00Z";
  const session: AgentSession = {
    id: "discovery-id", conversationId: "task", role: "discovery", label: "Discovery",
    status: "idle", createdAt: at, updatedAt: at
  };
  try {
    const result = await runtime.run(session, "/work/discovery", "Khảo sát tổng quan", {
      onThread: id => { session.threadId = id; },
      onTurn: id => { session.turnId = id; }
    }, { model: "demo", effort: "low" }, ["/work/discovery", "/work/api", "/work/web"]);
    const response = JSON.parse(result) as {
      cwd: string; approval: string;
      policy: { type: string; networkAccess: boolean; access: {
        type: string; includePlatformDefaults: boolean; readableRoots: string[]
      } }
    };
    assert.equal(session.threadId, "discovery-thread");
    assert.equal(response.cwd, "/work/discovery");
    assert.equal(response.approval, "never");
    assert.equal(response.policy.type, "readOnly");
    assert.equal(response.policy.networkAccess, false);
    assert.equal(response.policy.access.type, "restricted");
    assert.equal(response.policy.access.includePlatformDefaults, true);
    assert.deepEqual(response.policy.access.readableRoots,
      ["/work/discovery", "/work/api", "/work/web"]);
  } finally { client.stop(); }
});
