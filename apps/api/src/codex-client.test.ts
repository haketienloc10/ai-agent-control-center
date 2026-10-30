import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexClient } from "./codex-client.js";

test("Codex JSONL client handshake và nhận notification", async () => {
  const fake = [
    'process.stdin.setEncoding("utf8");',
    'let buf="";',
    'process.stdin.on("data", (chunk) => { buf += chunk; let i;',
    'while ((i=buf.indexOf(String.fromCharCode(10)))>=0) { const line=buf.slice(0,i);buf=buf.slice(i+1);',
    'if (!line) continue; const m=JSON.parse(line);',
    'if(m.method==="initialize") console.log(JSON.stringify({id:m.id,result:{}}));',
    'if(m.method==="thread/start") console.log(JSON.stringify({id:m.id,result:{thread:{id:"t1"}}}));',
    'if(m.method==="turn/start") {console.log(JSON.stringify({id:m.id,result:{turn:{id:"u1",status:"inProgress"}}}));',
    'console.log(JSON.stringify({method:"turn/completed",params:{threadId:"t1",turn:{id:"u1",status:"completed"}}}));}',
    '} });'
  ].join("");
  const client = new CodexClient(process.execPath, ["-e", fake]);
  try {
    await client.start();
    const received = new Promise<string>((resolve) => {
      client.on("notification", (m: { method: string }) => {
        if (m.method === "turn/completed") resolve(m.method);
      });
    });
    const result = await client.request<{ thread: { id: string } }>("thread/start", {});
    assert.equal(result.thread.id, "t1");
    await client.request("turn/start", { threadId: "t1", input: [] });
    assert.equal(await received, "turn/completed");
  } finally {
    client.stop();
  }
});
