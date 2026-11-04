import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, LeadCommand } from "@aacc/contracts";
import { CodexClient } from "./codex-client.js";
import { CodexAgentRuntime } from "./codex-runtime.js";

const code = [
  'process.stdin.setEncoding("utf8");let buf="";',
  'const send=m=>console.log(JSON.stringify(m));',
  'const complete=(threadId,id,text)=>{',
  'send({method:"item/completed",params:{threadId,item:{type:"agentMessage",text}}});',
  'send({method:"turn/completed",params:{threadId,turn:{id,status:"completed"}}});};',
  'process.stdin.on("data",chunk=>{buf+=chunk;let at;',
  'while((at=buf.indexOf(String.fromCharCode(10)))>=0){',
  'const line=buf.slice(0,at);buf=buf.slice(at+1);if(!line)continue;',
  'const m=JSON.parse(line);',
  'if(m.method==="initialize"){',
  'if(m.params?.capabilities?.experimentalApi!==true){',
  'send({id:m.id,error:{code:-32602,message:"Missing experimentalApi"}});}else send({id:m.id,result:{}});}',
  'if(m.method==="thread/start"){',
  'if(!m.params.dynamicTools || m.params.dynamicTools.length!==3){',
  'send({id:m.id,error:{code:-32602,message:"Missing dynamicTools"}});}else',
  'send({id:m.id,result:{thread:{id:"new-lead-thread"}}});}',
  'if(m.method==="thread/resume")send({id:m.id,result:{thread:{id:m.params.threadId}}});',
  'if(m.method==="turn/start"){',
  'send({id:m.id,result:{turn:{id:"turn-1",status:"inProgress"}}});',
  'if(m.params.threadId==="new-lead-thread"){',
  'send({method:"item/tool/call",id:900,params:{',
  'threadId:"new-lead-thread",turnId:"turn-1",callId:"call-1",tool:"spawn_peer",',
  'arguments:{moduleId:"web",label:"Todo Web",',
  'message:"GET /api/todos responds "+JSON.stringify({todos:[{id:1}]})}',
  '}});',
  '}else{',
  'if(!m.params.outputSchema){',
  'send({method:"turn/completed",params:{threadId:m.params.threadId,turn:{id:"turn-1",status:"failed"}}});',
  '}else{complete(m.params.threadId,"turn-1",JSON.stringify({',
  'reply:"Legacy Lead can send JSON",commands:[{type:"finish",moduleId:null,',
  'sessionId:null,message:null,label:null,summary:"Done"}]}));}',
  '}}',
  'if(m.id===900&&m.result){',
  'if(!m.result.success){process.exit(2);}',
  'complete("new-lead-thread","turn-1","Đã gọi công cụ tạo Peer Web");',
  '}',
  '}});'
].join("");

const now = "2026-11-04T00:00:00Z";
function lead(threadId?: string): AgentSession {
  return { id: "lead", conversationId: "c1", role: "lead", label: "Lead",
    status: "idle", ...(threadId ? { threadId } : {}),
    createdAt: now, updatedAt: now };
}

test("Codex app-server dynamicTools dispatches actual tool call with nested API JSON", async () => {
  const client = new CodexClient(process.execPath, ["-e", code]);
  const runtime = new CodexAgentRuntime(client);
  let called = 0;
  let protocol = "";
  const session = lead();
  try {
    const output = await runtime.run(session, "/workspace", "Hãy triển khai Todo Web", {
      onThread: id => { session.threadId = id; },
      onTurn: id => { session.turnId = id; },
      onToolProtocol: p => { protocol = p; },
      onToolUsed: () => { called++; },
      onLeadTool: async (id, command: LeadCommand) => {
        assert.equal(id, "new-lead-thread:call-1");
        assert.equal(command.type, "spawn_peer");
        if (command.type === "spawn_peer") {
          assert.equal(command.moduleId, "web");
          assert.match(command.message, /\{"todos":\[\{"id":1\}\]\}/);
        }
        return "Created Peer Web";
      }
    });
    assert.equal(protocol, "dynamic");
    assert.equal(called, 1);
    assert.equal(output, "Đã gọi công cụ tạo Peer Web");
  } finally { client.stop(); }
});

test("Existing Lead Thread keeps context and requests outputSchema instead of retrofitting tools", async () => {
  const client = new CodexClient(process.execPath, ["-e", code]);
  const runtime = new CodexAgentRuntime(client);
  const session = lead("old-lead-thread");
  try {
    const output = await runtime.run(session, "/workspace", "Tiếp tục Todo", {
      onThread: id => assert.equal(id, "old-lead-thread"),
      onTurn: () => {}
    });
    const parsed = JSON.parse(output) as { reply: string; commands: Array<{ type: string }> };
    assert.equal(parsed.reply, "Legacy Lead can send JSON");
    assert.equal(parsed.commands[0].type, "finish");
  } finally { client.stop(); }
});
