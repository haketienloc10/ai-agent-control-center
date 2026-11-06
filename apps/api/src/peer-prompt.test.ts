import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runPeerPromptDemo, demoMarkdown } from "../../../scripts/demo-peer-prompts.js";

test("Two Peer turns send self-contained checkpoints through JSON-RPC while reusing one Thread", async () => {
  const demo = await runPeerPromptDemo();
  assert.equal(demo.peerSessions, 1);
  assert.equal(demo.prompts.length, 2);
  const starts = demo.requests.filter(r => r.method === "thread/start");
  const resumes = demo.requests.filter(r => r.method === "thread/resume");
  assert.equal(starts.length, 1); assert.equal(resumes.length, 1);
  assert.equal(starts[0].params!.dynamicTools, undefined);
  assert.equal(resumes[0].params!.threadId, "demo-peer-thread");
  for (const request of [...starts, ...resumes]) {
    assert.ok(String(request.params!.developerInstructions).includes("ACTIVE_DECISIONS"));
    assert.ok(String(request.params!.developerInstructions).includes("MODULE: api"));
  }
  for (let index = 0; index < 2; index++) {
    const prompt = demo.prompts[index];
    const packet = demo.assignments[index].contextPacket!;
    assert.ok(prompt.includes("ASSIGNMENT: " + demo.assignments[index].id));
    assert.ok(prompt.includes("CURRENT_GOAL:\n" + demo.brief.goal));
    for (const item of [...demo.brief.acceptanceCriteria, ...demo.constraints]) assert.ok(prompt.includes(item));
    assert.ok(prompt.includes("dueDate dùng YYYY-MM-DD. Chưa hỗ trợ null."));
    assert.deepEqual(packet.peerCheckpoint?.constraints, demo.constraints);
    assert.doesNotMatch(prompt, /TASK_BRIEF_FROM_LEAD|DECISIONS_ALREADY_IN_THREAD/);
  }
  assert.match(demo.prompts[0], /ORIGINAL_USER_REQUEST:/);
  assert.doesNotMatch(demo.prompts[1], /ORIGINAL_USER_REQUEST:/);
  assert.ok(demo.prompts[1].includes("CONTINUES: " + demo.assignments[0].id));
  assert.match(demo.prompts[1], /PREVIOUS_CONTEXT:[^]*Đã triển khai dueDate; còn thiếu validation/);
  assert.ok(!demo.prompts[1].includes(demo.reportText), "raw report is not resent");
  assert.deepEqual(demo.assignments[1].contextPacket?.sources, []);
  assert.equal(readFileSync(new URL("../../../docs/PEER_PROMPT_DEMO.md", import.meta.url), "utf8"),
    demoMarkdown(demo.normalizedPrompts), "checked-in demo is the normalized runtime payload");
});
