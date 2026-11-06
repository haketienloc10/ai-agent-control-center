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
  'const name=m.params.permissions;',
  'const p=m.params.config?.["permissions."+name];',
  'const roots=m.params.runtimeWorkspaceRoots;',
  'const expected=["/work/discovery","/work/api","/work/web"];',
  'if(m.params.dynamicTools || m.params.sandbox ||',
  'name!=="aacc-discovery-discovery-id" ||',
  'JSON.stringify(roots)!==JSON.stringify(expected) ||',
  'p?.filesystem?.[":minimal"]!=="read" ||',
  'p?.filesystem?.[":workspace_roots"]?.["."]!=="read" ||',
  'p?.network?.enabled!==false || JSON.stringify(p).includes("write"))',
  'send({id:m.id,error:{message:"Invalid Discovery restricted permission profile"}});',
  'else send({id:m.id,result:{thread:{id:"discovery-thread"},',
  'activePermissionProfile:{id:name}}});}',
  'if(m.method==="turn/start"){',
  'if(m.params.sandboxPolicy || m.params.permissions!=="aacc-discovery-discovery-id")',
  'send({id:m.id,error:{message:"Discovery must select the named profile, without sandboxPolicy"}});',
  'const p=m.params.permissions;',
  'send({id:m.id,result:{turn:{id:"turn-1",status:"inProgress"}}});',
  'send({method:"item/completed",params:{threadId:"discovery-thread",turnId:"turn-1",',
  'item:{type:"agentMessage",text:JSON.stringify({profile:p,',
  'approval:m.params.approvalPolicy,cwd:m.params.cwd})}}});',
  'send({method:"turn/completed",params:{threadId:"discovery-thread",',
  'turn:{id:"turn-1",status:"completed"}}});',
  '}}});'
].join("");

test("Discovery app-server turn uses named restricted permissions without legacy sandboxPolicy", async () => {
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
      cwd: string; approval: string; profile: string;
    };
    assert.equal(session.threadId, "discovery-thread");
    assert.equal(response.cwd, "/work/discovery");
    assert.equal(response.approval, "never");
    assert.equal(response.profile, "aacc-discovery-discovery-id");
  } finally { client.stop(); }
});


test("Discovery refuses an app-server response that silently applies a different profile", async () => {
  const wrongServer = server
    .replace('name!=="aacc-discovery-discovery-id"', 'name!=="aacc-discovery-discovery-wrong"')
    .replace("activePermissionProfile:{id:name}", 'activePermissionProfile:{id:":read-only"}');
  const client = new CodexClient(process.execPath, ["-e", wrongServer]);
  const at = "2026-11-05T00:00:00Z";
  const session: AgentSession = {
    id: "discovery-wrong", conversationId: "task", role: "discovery", label: "Discovery",
    status: "idle", createdAt: at, updatedAt: at
  };
  try {
    await assert.rejects(new CodexAgentRuntime(client).run(session, "/work/discovery",
      "Khảo sát tổng quan", { onThread: () => {}, onTurn: () => {} },
      {}, ["/work/discovery", "/work/api", "/work/web"]),
    /không xác nhận Discovery permission profile/);
  } finally { client.stop(); }
});
