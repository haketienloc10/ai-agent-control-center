import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@aacc/contracts";
import { CodexClient } from "./codex-client.js";
import { createTask } from "./domain.js";
import { SessionManager } from "./session-manager.js";
import { TaskStore } from "./store.js";

test("Final Reviewer dùng Thread mới cho mỗi lượt; không dùng instructions Lead, read-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-separate-reviewer-"));
  const config: WorkspaceConfig = {
    lead: { cwd: dir, instructions: "SECRET_LEAD_DIRECTIVE_DO_NOT_INCLUDE_IN_REVIEWER" },
    reviewer: { cwd: dir, instructions: "REVIEWER_INDEPENDENT_INSTRUCTIONS" },
    modules: [{ id: "web", label: "Web", path: dir }]
  };
  const mock = [
    'let buf="";let seq=0;let threads=new Set();',
    'process.stdin.on("data",chunk=>{buf+=chunk.toString();let n;',
    'while((n=buf.indexOf(String.fromCharCode(10)))>=0){',
    'const line=buf.slice(0,n);buf=buf.slice(n+1);if(!line)continue;',
    'const m=JSON.parse(line);',
    'if(m.method==="initialize")console.log(JSON.stringify({id:m.id,result:{}}));',
    'if(m.method==="thread/start"){const id="t"+(++seq);threads.add(id);',
    'const valid=m.params.sandbox==="read-only"&&m.params.approvalPolicy==="never";',
    'if(!valid){console.log(JSON.stringify({id:m.id,error:{code:-1,message:"Expected read-only"}}));continue;}',
    'console.log(JSON.stringify({id:m.id,result:{thread:{id}}}));}',
    'if(m.method==="thread/resume"){console.log(JSON.stringify({id:m.id,error:{code:-1,message:"Reviewer must be fresh"}}));}',
    'if(m.method==="turn/start"){const p=m.params;',
    'const valid=p.sandboxPolicy?.type==="readOnly"&&p.approvalPolicy==="never"&&threads.has(p.threadId);',
    'if(!valid){console.log(JSON.stringify({id:m.id,error:{code:-1,message:"Review turn wrong policy"}}));continue;}',
    'const prompt=p.input[0].text;',
    'const output=JSON.stringify({clean:!prompt.includes("SECRET_LEAD_DIRECTIVE"),',
    'reviewerInstructions:prompt.includes("REVIEWER_INDEPENDENT_INSTRUCTIONS"),threadId:p.threadId});',
    'console.log(JSON.stringify({id:m.id,result:{turn:{id:"turn"+seq,status:"inProgress"}}}));',
    'setImmediate(()=>{',
    'console.log(JSON.stringify({method:"item/completed",params:{threadId:p.threadId,',
    'item:{type:"agentMessage",text:output}}}));',
    'console.log(JSON.stringify({method:"turn/completed",params:{threadId:p.threadId,turn:{status:"completed"}}}));',
    '});}',
    '}});'
  ].join("");
  const codex = new CodexClient(process.execPath, ["-e", mock]);
  const store = new TaskStore(dir);
  try {
    const manager = new SessionManager(config, store, codex);
    const tasks = [
      createTask({ title: "Review 1", prompt: "Review artifacts", role: "reviewer" }, config),
      createTask({ title: "Review 2", prompt: "Review after rework", role: "reviewer" }, config)
    ];
    tasks.forEach((task) => store.add(task));
    const outputs = [];
    for (const task of tasks) {
      outputs.push(JSON.parse(await manager.runAndWait(task.id)) as {
        clean: boolean; reviewerInstructions: boolean; threadId: string
      });
    }
    assert.ok(outputs.every((r) => r.clean && r.reviewerInstructions));
    assert.notEqual(outputs[0].threadId, outputs[1].threadId);
    assert.notEqual(store.get(tasks[0].id)?.threadId, store.get(tasks[1].id)?.threadId);
    assert.ok(tasks.every((t) => store.get(t.id)?.status === "completed"));

    const bad = createTask({ title: "Unsafe resume", role: "reviewer", prompt: "Retry", }, config);
    bad.threadId = tasks[0].threadId;
    store.add(bad);
    await assert.rejects(() => manager.runAndWait(bad.id), /Reviewer cannot reuse/);
  } finally {
    codex.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
