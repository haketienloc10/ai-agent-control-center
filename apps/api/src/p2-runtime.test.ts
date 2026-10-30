import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@aacc/contracts";
import { createTask } from "./domain.js";
import { WorktreeManager } from "./worktree-manager.js";
import { TaskStore } from "./store.js";
import { SessionManager } from "./session-manager.js";
import { CodexClient } from "./codex-client.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("P2 fake Codex executes in detached worktree and never edits original source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aacc-p2-runtime-"));
  let client: CodexClient | undefined;
  let store: TaskStore | undefined;
  try {
    const sourceRepo = join(dir, "source");
    mkdirSync(sourceRepo);
    git(sourceRepo, "init", "-q");
    writeFileSync(join(sourceRepo, "README.md"), "original\n");
    git(sourceRepo, "add", ".");
    git(sourceRepo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
    const config: WorkspaceConfig = {
      lead: { cwd: dir, instructions: "Lead" },
      modules: [{ id: "web", label: "Web", path: sourceRepo }]
    };
    const fake = [
      'const fs=require("node:fs"); const path=require("node:path");',
      'let buf="";let seq=0;let cwd="";',
      'process.stdin.on("data",chunk=>{buf+=chunk.toString();let i;',
      'while((i=buf.indexOf(String.fromCharCode(10)))>=0){',
      'const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line)continue;',
      'const msg=JSON.parse(line);',
      'if(msg.method==="initialize")console.log(JSON.stringify({id:msg.id,result:{}}));',
      'if(msg.method==="thread/start"){cwd=msg.params.cwd;',
      'console.log(JSON.stringify({id:msg.id,result:{thread:{id:"thread"+(++seq)}}}));}',
      'if(msg.method==="turn/start"){',
      'fs.writeFileSync(path.join(cwd,"generated.txt"),"from fake agent");',
      'console.log(JSON.stringify({id:msg.id,result:{turn:{id:"turn"+seq,status:"inProgress"}}}));',
      'console.log(JSON.stringify({method:"turn/started",params:{threadId:msg.params.threadId}}));',
      'console.log(JSON.stringify({method:"item/completed",params:{threadId:msg.params.threadId,item:{type:"agentMessage",text:"done"}}}));',
      'console.log(JSON.stringify({method:"turn/completed",params:{threadId:msg.params.threadId,turn:{status:"completed"}}}));',
      '}',
      '}});'
    ].join("");
    client = new CodexClient(process.execPath, ["-e", fake]);
    store = new TaskStore(join(dir, "data"));
    const worktrees = new WorktreeManager(config, join(dir, "data"));
    const manager = new SessionManager(config, store, client, 2, worktrees);
    const task = store.add(createTask({ title: "Demo", prompt: "Make file", role: "peer", moduleId: "web" }, config));
    task.workflowId = "wf-p2";
    const output = await manager.runAndWait(task.id);
    const result = store.get(task.id)!;
    assert.equal(output, "done");
    assert.equal(result.status, "completed");
    assert.ok(result.executionCwd);
    assert.notEqual(result.executionCwd, sourceRepo);
    assert.ok(existsSync(join(result.executionCwd!, "generated.txt")));
    assert.equal(existsSync(join(sourceRepo, "generated.txt")), false);
    assert.equal(git(sourceRepo, "status", "--porcelain"), "");
  } finally {
    client?.stop();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
