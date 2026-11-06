/** E2E tốn token: mọi vai trò chạy Codex thật, fixture riêng, không sửa source app. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexClient } from "../apps/api/src/codex-client.js";
import { CodexAgentRuntime, type AgentRuntime } from "../apps/api/src/codex-runtime.js";
import { CoordinationStore } from "../apps/api/src/coordination-store.js";
import { Coordinator } from "../apps/api/src/coordinator.js";

async function main() {
const outputDir = resolve(process.argv[2] ?? join(".data", "codex-e2e", new Date().toISOString().replaceAll(":", "-")));
mkdirSync(outputDir, { recursive: true });
const fixture = mkdtempSync(join(tmpdir(), "aacc-real-e2e-"));
const leadDir = join(fixture, "lead");
const discoveryDir = join(fixture, "discovery");
const moduleDir = join(fixture, "api");
for (const dir of [leadDir, discoveryDir, moduleDir]) mkdirSync(dir);
writeFileSync(join(moduleDir, "todo.mjs"), `export function createTodo(input) {
  return { id: input.id, title: input.title };
}
export function readTodo(stored) { return structuredClone(stored); }
`);
writeFileSync(join(moduleDir, "todo.test.mjs"), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTodo, readTodo } from './todo.mjs';
test('dữ liệu cũ', () => {
  assert.deepEqual(createTodo({id:1,title:'cũ'}), {id:1,title:'cũ'});
  assert.deepEqual(readTodo({id:1,title:'cũ'}), {id:1,title:'cũ'});
});
`);

const store = new CoordinationStore(join(outputDir, "store"));
store.updateSettings({ lead: { model: "gpt-6-luna" }, discovery: { model: "gpt-6-luna" }, peer: { model: "gpt-6-luna" } });
let currentRole = "";
const requests: Array<{ role: string; method: string; params: Record<string, unknown> }> = [];
class TracedClient extends CodexClient {
  override request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    const entry = { role: currentRole, method, params: structuredClone(params) };
    requests.push(entry);
    appendFileSync(join(outputDir, "requests.jsonl"), JSON.stringify(entry) + "\n");
    return super.request<T>(method, params, timeoutMs);
  }
}
const client = new TracedClient();
client.on("serverRequest", event => {
  if (event.method === "item/tool/call") {
    appendFileSync(join(outputDir, "lead-tool-calls.jsonl"), JSON.stringify(event) + "\n");
    console.log("Lead tool:", event.params.tool);
  }
});
client.on("notification", event => {
  if (event.method === "error") appendFileSync(join(outputDir, "errors.jsonl"), JSON.stringify(event) + "\n");
});
const codexRuntime = new CodexAgentRuntime(client);
const runtime: AgentRuntime = {
  async run(session, cwd, prompt, hooks, selection, roots, instructions) {
    currentRole = session.role;
    console.log("Start:", session.role, selection?.model, session.threadId ?? "new Thread");
    const result = await codexRuntime.run(session, cwd, prompt, hooks, selection, roots, instructions);
    console.log("Completed:", session.role);
    return result;
  }
};

const original = `Thêm dueDate cho Todo API. Giữ dữ liệu cũ và báo bằng chứng kiểm thử.
Đây là kịch bản E2E hai assignment thực, không phải yêu cầu lập kế hoạch:
1. Giao Discovery khảo sát sơ bộ module api trước. Sau báo cáo Discovery mới giao Peer.
2. Cập nhật Task Brief với goal "Todo API hỗ trợ dueDate và tiếp tục đọc được dữ liệu cũ.", tiêu chí gồm nhận/lưu YYYY-MM-DD, đọc dữ liệu cũ không dueDate và có bằng chứng kiểm thử. Record decision due-date-format: dueDate dùng YYYY-MM-DD, chưa hỗ trợ null, không chuyển timezone, affects api. Dùng message user này làm evidenceRef.
3. Assignment Peer đầu: triển khai createTodo nhận và giữ dueDate; readTodo giữ dữ liệu cũ. Chỉ kiểm tra định dạng, CHƯA kiểm tra ngày có tồn tại trong lịch; phần kiểm tra ngày dành riêng cho assignment thứ hai. Peer chạy node --test và báo cáo thật. Gửi nguồn Discovery bằng contextRefs.
4. Sau báo cáo Peer đầu, giao assignment thứ hai cho cùng module: từ chối ngày không tồn tại như 2026-02-30, hỗ trợ năm nhuận, hồi quy ngày hợp lệ và dữ liệu cũ. Giữ nguyên goal/criteria và decision. Chọn báo cáo Peer trước bằng contextRefs và viết previousContext.summary dựa trên báo cáo đó. Không đính kèm lại nguồn Discovery ở lượt này.
Mỗi assignment gửi đủ constraints: "Chỉ sửa module api.", "Không tự chuyển timezone.", "Giữ dữ liệu hiện có."; không override model/effort. WORK và EXPECTED_RESULT do bạn viết dựa trên tình trạng thực tế. Chỉ finish sau báo cáo Peer thứ hai và đối chiếu kết quả.
Fixture là thư viện Node ESM todo.mjs, không có HTTP server/UI; sửa ngay fixture, không cần dựng framework hoặc hỏi thêm. Không đọc source module từ Lead. Không thêm dependency.`;
const conversation = store.createConversation(original);

try {
  console.log("Evidence:", outputDir, "Fixture:", fixture);
  await new Promise<void>((done, reject) => {
    const check = () => {
      const snapshot = store.snapshot();
      const failure = snapshot.deliveries.find(d => d.status === "interrupted");
      const idle = store.session(conversation.leadSessionId)?.status === "idle";
      if (failure) {
        store.off("change", check); reject(new Error(failure.error ?? "Delivery failed"));
      } else if (store.conversation(conversation.id)?.status === "finished" && idle) {
        store.off("change", check); done();
      }
    };
    store.on("change", check);
    new Coordinator({ lead: { cwd: leadDir }, discovery: { cwd: discoveryDir },
      modules: [{ id: "api", label: "Todo fixture", path: moduleDir }] }, store, runtime, 1);
  });
  await new Promise<void>(done => setImmediate(done));
  const snapshot = store.snapshot();
  writeFileSync(join(outputDir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  const peers = snapshot.sessions.filter(s => s.role === "peer");
  assert.equal(peers.length, 1, "Một Peer cho module api");
  assert.equal(snapshot.sessions.filter(s => s.role === "discovery").length, 1);
  const turns = requests.filter(r => r.role === "peer" && r.method === "turn/start");
  assert.equal(turns.length, 2, "Hai lượt Peer thật");
  assert.equal(requests.filter(r => r.role === "peer" && r.method === "thread/start").length, 1);
  assert.equal(requests.filter(r => r.role === "peer" && r.method === "thread/resume").length, 1);
  assert.equal(turns[0].params.threadId, turns[1].params.threadId);
  const assignments = snapshot.messages.filter(m => m.from === "lead" && m.to === "peer");
  assert.equal(assignments.length, 2);
  const prompts = turns.map(r => (r.params.input as Array<{ text: string }>)[0].text);
  const doc = readFileSync(new URL("../docs/PEER_PROMPT_DEMO.md", import.meta.url), "utf8");
  const docPrompts = [...doc.matchAll(/```text\n([^]*?)\n```/g)].map(match => match[1]);
  const sections = (prompt: string) => [...prompt.matchAll(/^([A-Z_]+):/gm)].map(m => m[1]);
  for (let i = 0; i < 2; i++) {
    writeFileSync(join(outputDir, `peer-turn-${i + 1}.txt`), prompts[i] + "\n");
    assert.deepEqual(sections(prompts[i]), sections(docPrompts[i]), "Các section đúng thứ tự demo");
    assert.equal(turns[i].params.model, "gpt-6-luna");
    const checkpoint = assignments[i].contextPacket!.peerCheckpoint!;
    assert.ok(prompts[i].includes("ASSIGNMENT: " + assignments[i].id));
    assert.ok(prompts[i].includes("CURRENT_GOAL:\n" + checkpoint.goal));
    assert.deepEqual(checkpoint.constraints, ["Chỉ sửa module api.", "Không tự chuyển timezone.", "Giữ dữ liệu hiện có."]);
    for (const item of [...checkpoint.acceptanceCriteria, ...checkpoint.constraints]) assert.ok(prompts[i].includes(item));
    for (const decision of assignments[i].contextPacket!.decisions!) assert.ok(prompts[i].includes(decision.decision));
    assert.doesNotMatch(prompts[i], /TASK_BRIEF_FROM_LEAD|DECISIONS_ALREADY_IN_THREAD|SOURCES_ALREADY_IN_THREAD/);
  }
  assert.ok(prompts[1].includes("CONTINUES: " + assignments[0].id));
  assert.equal(assignments[1].contextPacket!.originalRequest, undefined);
  assert.deepEqual(assignments[1].contextPacket!.decisions, assignments[0].contextPacket!.decisions);
  assert.deepEqual(assignments[1].contextPacket!.peerCheckpoint!.acceptanceCriteria,
    assignments[0].contextPacket!.peerCheckpoint!.acceptanceCriteria);
  assert.equal(assignments[1].contextPacket!.peerCheckpoint!.goal, assignments[0].contextPacket!.peerCheckpoint!.goal);
  const report = snapshot.messages.find(m => m.from === "peer")!;
  assert.ok(assignments[1].contextPacket!.previousContext!.some(s => s.messageId === report.id && s.summary));
  assert.deepEqual(assignments[1].contextPacket!.sources, []);
  assert.ok(!prompts[1].includes(report.text), "Không gửi lại nguyên văn báo cáo cũ");
  for (const request of requests.filter(r => r.role === "peer" && /^thread\/(start|resume)$/.test(r.method))) {
    assert.equal(request.params.dynamicTools, undefined);
    assert.ok(String(request.params.developerInstructions).includes(readFileSync(new URL("../instructions/peer.md", import.meta.url), "utf8")));
  }
  // Oracle độc lập kiểm chứng implementation thực do Peer sửa, không tin riêng báo cáo model.
  const oracle = `import assert from 'node:assert/strict';
import {createTodo,readTodo} from './todo.mjs';
assert.deepEqual(createTodo({id:1,title:'cũ'}),{id:1,title:'cũ'});
assert.deepEqual(readTodo({id:1,title:'cũ'}),{id:1,title:'cũ'});
for(const dueDate of ['2026-12-31','2028-02-29']) {
  const todo=createTodo({id:2,title:'mới',dueDate});
  assert.equal(todo.dueDate,dueDate);assert.equal(readTodo(todo).dueDate,dueDate);
}
for(const dueDate of ['2026-02-30','2026-02-29','2026-13-01','abc',null]) {
  assert.throws(()=>createTodo({id:3,title:'sai',dueDate}));
}
console.log('PASS: valid dates, leap year, invalid dates, null, legacy data');`;
  const oracleOutput = execFileSync(process.execPath, ["--input-type=module", "-e", oracle], { cwd: moduleDir, encoding: "utf8" });
  const testOutput = execFileSync(process.execPath, ["--test"], { cwd: moduleDir, encoding: "utf8" });
  writeFileSync(join(outputDir, "fixture-tests.txt"), oracleOutput + testOutput);
  const comparison = { status: "PASS", model: "gpt-6-luna", fixture, outputDir,
    peerThreadId: peers[0].threadId, peerTurns: turns.length,
    exactTextEqualsDemo: prompts.map((p, i) => p === docPrompts[i]),
    sectionsMatchDemo: true, checkpointRepeated: true, previousReportDeduplicated: true,
    fixtureOracle: oracleOutput.trim(), roles: snapshot.sessions.map(s => s.role),
    scope: "Store → Coordinator → Codex app-server thật, Lead/Discovery/Peer thật; fixture thư viện Node; không browser/HTTP E2E" };
  writeFileSync(join(outputDir, "result.json"), JSON.stringify(comparison, null, 2));
  console.log(JSON.stringify(comparison, null, 2));
} catch (error) {
  writeFileSync(join(outputDir, "snapshot.json"), JSON.stringify(store.snapshot(), null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  client.stop(); store.close();
  writeFileSync(join(outputDir, "fixture-path.txt"), fixture + "\n");
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
