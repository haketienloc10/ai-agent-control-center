import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, LeadCommand } from "@aacc/contracts";
import { CodexClient } from "./codex-client.js";
import { CodexAgentRuntime } from "./codex-runtime.js";

const code = [
  'process.stdin.setEncoding("utf8");let buf="";let seq=0;',
  'const send=m=>console.log(JSON.stringify(m));',
  'process.stdin.on("data",chunk=>{buf+=chunk;let at;',
  'while((at=buf.indexOf(String.fromCharCode(10)))>=0){',
  'const line=buf.slice(0,at);buf=buf.slice(at+1);if(!line)continue;',
  'const m=JSON.parse(line);',
  'if(m.method==="initialize"){',
  'if(m.params?.capabilities?.experimentalApi!==true)send({id:m.id,error:{code:-32602,message:"Missing experimentalApi"}});',
  'else send({id:m.id,result:{}});}',
  'if(m.method==="thread/start"){',
  'if(!m.params.dynamicTools || m.params.dynamicTools.length!==5)',
  'send({id:m.id,error:{code:-32602,message:"Missing dynamicTools"}});',
  'else send({id:m.id,result:{thread:{id:"lead-thread"}}});}',
  'if(m.method==="thread/resume")send({id:m.id,result:{thread:{id:m.params.threadId}}});',
  'if(m.method==="turn/start"){',
  'const n=++seq;const id="turn-"+n;',
  'send({id:m.id,result:{turn:{id,status:"inProgress"}}});',
  'send({method:"item/tool/call",id:900+n,params:{',
  'threadId:m.params.threadId,turnId:id,callId:"call-"+n,',
  'tool:n===1?"spawn_peer":"finish",arguments:n===1?',
  '{moduleId:"web",message:"GET /api/todos returns "+JSON.stringify({todos:[{id:1}]})}:',
  '{} }});}',
  'if(typeof m.id==="number"&&m.id>900&&m.result){',
  'if(!m.result.success){process.exit(2);}',
  'const n=m.id-900;const id="turn-"+n;',
  'send({method:"item/completed",params:{threadId:"lead-thread",turnId:id,',
  'item:{type:"agentMessage",text:"Turn "+n+" done"}}});',
  'send({method:"turn/completed",params:{threadId:"lead-thread",turn:{id,status:"completed"}}});',
  '}}});'
].join("");
const now = "2026-11-04T00:00:00Z";
function lead(): AgentSession {
  return { id: "lead", conversationId: "c1", role: "lead", label: "Lead",
    status: "idle", createdAt: now, updatedAt: now };
}
test("Dynamic tools dispatch nested JSON and resume the same Lead thread", async () => {
  const client = new CodexClient(process.execPath, ["-e", code]);
  const runtime = new CodexAgentRuntime(client);
  const session = lead();
  const commands: LeadCommand[] = [];
  try {
    const hooks = {
      onThread: (id: string) => { session.threadId = id; },
      onTurn: (id: string) => { session.turnId = id; },
      onLeadTool: (id: string, command: LeadCommand) => {
        assert.match(id, /^lead-thread:call-[12]$/);
        commands.push(command);
        return "Tool accepted";
      }
    };
    assert.equal(await runtime.run(session, "/workspace", "Create Web", hooks), "Turn 1 done");
    assert.equal(await runtime.run(session, "/workspace", "Finish", hooks), "Turn 2 done");
    assert.equal(session.threadId, "lead-thread");
    assert.equal(commands[0]?.type, "spawn_peer");
    if (commands[0]?.type === "spawn_peer") {
      assert.match(commands[0].message, /\{"todos":\[\{"id":1\}\]\}/);
    }
    assert.deepEqual(commands[1], { type: "finish" });
  } finally { client.stop(); }
});
test("Unsupported dynamicTools fails, never falls back to JSON routing", async () => {
  const server = [
    'process.stdin.setEncoding("utf8");let b="";',
    'process.stdin.on("data",c=>{b+=c;let i;',
    'while((i=b.indexOf(String.fromCharCode(10)))>=0){',
    'const s=b.slice(0,i);b=b.slice(i+1);if(!s)continue;',
    'const m=JSON.parse(s);',
    'if(m.method==="initialize")console.log(JSON.stringify({id:m.id,result:{}}));',
    'if(m.method==="thread/start")console.log(JSON.stringify({id:m.id,',
    'error:{code:-32602,message:"dynamicTools not supported"}}));',
    '}});'
  ].join("");
  const client = new CodexClient(process.execPath, ["-e", server]);
  try {
    await assert.rejects(new CodexAgentRuntime(client).run(lead(), "/workspace", "Dispatch", {
      onThread: () => {}, onTurn: () => {}
    }), /dynamicTools not supported/);
  } finally { client.stop(); }
});
