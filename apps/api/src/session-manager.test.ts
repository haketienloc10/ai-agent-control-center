import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "./codex-client.js";
import { SessionManager } from "./session-manager.js";
import { TaskStore } from "./store.js";
import { createTask } from "./domain.js";
import type { WorkspaceConfig } from "@aacc/contracts";

test("SessionManager serialize Peer của cùng module, kể cả khi enqueue đồng thời", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aacc-sessions-"));
  const config: WorkspaceConfig = {
    lead: { cwd: directory, instructions: "Lead" },
    modules: [
      { id: "api", label: "API", path: directory },
      { id: "web", label: "Web", path: directory }
    ]
  };
  const fake = [
    'let buf=""; let id=0;',
    'process.stdin.on("data",x=>{buf+=x.toString();let i;',
    'while((i=buf.indexOf(String.fromCharCode(10)))>=0){',
    'const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line)continue;',
    'const m=JSON.parse(line);',
    'if(m.method==="initialize")console.log(JSON.stringify({id:m.id,result:{}}));',
    'if((m.method==="thread/start"||m.method==="turn/start") && m.params.approvalPolicy!=="on-request"){',
    'console.log(JSON.stringify({id:m.id,error:{code:-32602,message:"Invalid approvalPolicy"}}));continue;}',
    'if(m.method==="thread/start"){const threadId="t"+(++id);',
    'console.log(JSON.stringify({id:m.id,result:{thread:{id:threadId}}}));}',
    'if(m.method==="turn/start"){const threadId=m.params.threadId;',
    'console.log(JSON.stringify({id:m.id,result:{turn:{id:"u"+id,status:"inProgress"}}}));',
    'console.log(JSON.stringify({method:"turn/started",params:{threadId}}));',
    'setTimeout(()=>{',
    'console.log(JSON.stringify({method:"item/completed",params:{threadId,item:{type:"agentMessage",text:"ok"}}}));',
    'console.log(JSON.stringify({method:"turn/completed",params:{threadId,turn:{status:"completed"}}}));',
    '},30);}',
    '}});'
  ].join("");
  const client = new CodexClient(process.execPath, ["-e", fake]);
  try {
    const store = new TaskStore(directory);
    const sessions = new SessionManager(config, store, client, 2);
    const tasks = [
      createTask({ title: "api A", prompt: "A", role: "peer", moduleId: "api" }, config),
      createTask({ title: "api B", prompt: "B", role: "peer", moduleId: "api" }, config),
      createTask({ title: "web A", prompt: "C", role: "peer", moduleId: "web" }, config)
    ];
    tasks.forEach((task) => store.add(task));
    const output = await Promise.all(tasks.map((task) => sessions.runAndWait(task.id)));
    assert.deepEqual(output, ["ok", "ok", "ok"]);
    assert.ok(tasks.every((task) => store.get(task.id)?.status === "completed"));

    const active: Record<string, number> = { api: 0, web: 0 };
    let maxGlobal = 0;
    let maxPerModule = 0;
    for (const event of store.events()) {
      const moduleId = store.get(event.taskId)?.moduleId;
      if (!moduleId) continue;
      if (event.kind === "turn/started") active[moduleId]++;
      if (event.kind === "turn/completed") active[moduleId]--;
      maxGlobal = Math.max(maxGlobal, active.api + active.web);
      maxPerModule = Math.max(maxPerModule, active[moduleId]);
      assert.ok(active[moduleId] >= 0);
    }
    assert.equal(maxPerModule, 1);
    assert.ok(maxGlobal <= 2);
  } finally {
    client.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
