/** Demo giao thức bằng SQLite/Coordinator/Runtime/JSON-RPC thật và app-server giả. Không gọi model. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LeadCommand, TaskBrief, WorkspaceConfig } from "@aacc/contracts";
import { CodexClient, type RpcMessage } from "../apps/api/src/codex-client.js";
import { CodexAgentRuntime, type AgentRuntime } from "../apps/api/src/codex-runtime.js";
import { commandFromTool } from "../apps/api/src/lead-tools.js";
import { CoordinationStore } from "../apps/api/src/coordination-store.js";
import { Coordinator } from "../apps/api/src/coordinator.js";

export async function runPeerPromptDemo() {
  const directory = mkdtempSync(join(tmpdir(), "aacc-peer-demo-"));
  const tracePath = join(directory, "rpc.jsonl");
  const reportText = "Đã thêm dueDate; còn thiếu validation ngày không hợp lệ. Chi tiết dài chỉ có trong Thread.";
  // Chỉ Peer dùng transport này; Lead được lập kịch bản để có demo xác định, không tốn token.
  const serverCode = `
    import { appendFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    let number = 0;
    const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
    createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      appendFileSync(process.argv[1], line + '\\n');
      if (request.method === 'initialize') send({id:request.id,result:{}});
      if (request.method === 'thread/start' || request.method === 'thread/resume') {
        send({id:request.id,result:{thread:{id:'demo-peer-thread'}}});
      }
      if (request.method === 'turn/start') {
        const id = 'demo-turn-' + ++number;
        send({id:request.id,result:{turn:{id}}});
        send({method:'item/completed',params:{threadId:'demo-peer-thread',turnId:id,
          item:{type:'agentMessage',text:number===1?${JSON.stringify(reportText)}:'Đã hoàn thành lượt demo thứ hai.'}}});
        send({method:'turn/completed',params:{threadId:'demo-peer-thread',turn:{id,status:'completed'}}});
      }
    });`;
  const store = new CoordinationStore(directory);
  const client = new CodexClient(process.execPath, ["--input-type=module", "-e", serverCode, tracePath]);
  const peerRuntime = new CodexAgentRuntime(client);
  const config: WorkspaceConfig = { lead: { cwd: directory },
    modules: [{ id: "api", label: "API demo", path: directory }] };
  const original = "Thêm dueDate cho Todo API. Giữ dữ liệu cũ và báo bằng chứng kiểm thử.";
  const c = store.createConversation(original);
  const source = store.postUser(c.id, "dueDate dùng YYYY-MM-DD, không tự chuyển timezone.");
  const brief: TaskBrief = {
    goal: "Todo API hỗ trợ dueDate và tiếp tục đọc được dữ liệu cũ.",
    acceptanceCriteria: ["API nhận và lưu dueDate theo định dạng YYYY-MM-DD.",
      "Dữ liệu cũ không có dueDate vẫn đọc được.", "Có bằng chứng kiểm chứng những hành vi đã triển khai."],
    verified: [], preliminary: [], unknowns: [], nextDecision: "Peer xác minh và triển khai."
  };
  const constraints = ["Chỉ sửa module api.", "Không tự chuyển timezone.", "Giữ dữ liệu hiện có."];
  let leadTurns = 0;
  const runtime: AgentRuntime = {
    async run(session, cwd, prompt, hooks, selection, roots, instructions) {
      if (session.role === "peer") return peerRuntime.run(session, cwd, prompt, hooks, selection, roots, instructions);
      const turn = ++leadTurns;
      hooks.onThread("demo-lead-thread"); hooks.onTurn("demo-lead-turn-" + turn);
      let sequence = 0;
      const call = (command: LeadCommand) => {
        const { type, ...args } = command;
        return hooks.onLeadTool!("demo-call-" + turn + "-" + sequence++, commandFromTool(type, args));
      };
      if (turn === 1) {
        await call({ type: "update_task_brief", brief });
        await call({ type: "record_decision", topic: "due-date-format",
          decision: "dueDate dùng YYYY-MM-DD. Chưa hỗ trợ null.", rationale: "Định dạng do Lead chốt cho demo.",
          affects: ["api"], evidenceRefs: [source.id] });
        await call({ type: "assign_module", moduleId: "api", constraints, contextRefs: [source.id],
          message: "Xác minh cách API hiện nhận, lưu và đọc Todo.\nTriển khai dueDate theo quyết định hiện hành.\nNếu source hoặc contract mâu thuẫn, báo Lead kèm bằng chứng.",
          expectedResult: "Báo hành vi đã thực hiện, file đã sửa, command/cwd/kết quả thực tế và phần chưa kiểm chứng." });
      } else if (turn === 2) {
        const report = store.snapshot().messages.find(m => m.from === "peer")!;
        await call({ type: "assign_module", moduleId: "api", constraints, contextRefs: [report.id],
          previousContext: [{ messageId: report.id, summary: "Đã triển khai dueDate; còn thiếu validation ngày không hợp lệ." }],
          message: "Bổ sung validation để từ chối ngày không tồn tại, ví dụ 2026-02-30, cùng các giá trị sai định dạng.\nKiểm tra hồi quy ngày hợp lệ và dữ liệu cũ không có dueDate.\nĐọc implementation hiện có trước khi sửa.",
          expectedResult: "Báo hành vi validation sau sửa, file đã sửa, command/cwd/kết quả thực tế và phần chưa kiểm chứng." });
      } else await call({ type: "finish" });
      return "";
    }
  };
  try {
    await new Promise<void>((done, reject) => {
      // Deadline chỉ dành cho harness app-server giả, không phải timeout turn của app.
      const deadline = setTimeout(() => {
        store.off("change", check); reject(new Error("Demo không hoàn tất"));
      }, 10000);
      const check = () => {
        if (store.conversation(c.id)?.status === "finished" && store.session(c.leadSessionId)?.status === "idle") {
          clearTimeout(deadline); store.off("change", check); done();
        }
      };
      store.on("change", check);
      new Coordinator(config, store, runtime, 1);
    });
    await new Promise<void>(done => setImmediate(done));
    const requests = readFileSync(tracePath, "utf8").trim().split("\n").map(line => JSON.parse(line) as RpcMessage);
    const snapshot = store.snapshot();
    const assignments = snapshot.messages.filter(m => m.to === "peer" && m.from === "lead");
    const prompts = requests.filter(r => r.method === "turn/start").map(r =>
      (r.params!.input as Array<{ text: string }>)[0].text);
    const aliases = new Map<string, string>([
      [source.id, "U1"],
      [snapshot.messages.find(m => m.from === "peer")!.id, "R1"],
      [snapshot.conversations[0].decisions![0].id, "D1"],
      ...assignments.map((m, i): [string, string] => [m.id, "api-0" + (i + 1)])
    ]);
    const normalizedPrompts = prompts.map(prompt => {
      for (const [id, alias] of aliases) prompt = prompt.replaceAll(id, alias);
      return prompt.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "THOI_DIEM_NGUON");
    });
    return { requests, prompts, normalizedPrompts, assignments, reportText, brief, constraints,
      peerSessions: snapshot.sessions.filter(s => s.role === "peer").length };
  } finally {
    client.stop(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
}

export function demoMarkdown(prompts: string[]) {
  return [
    "Demo prompt hai lượt Lead–App–Peer, sinh bằng `npm run demo:peer-prompts -- docs/PEER_PROMPT_DEMO.md`.",
    "Dùng Store, Coordinator, Runtime và JSON-RPC stdio thật với app-server giả. Lead và báo cáo Peer được lập kịch bản; không chạy Codex/model, không triển khai tính năng dueDate hoặc kiểm thử tính năng đó.",
    "Nội dung lấy từ request turn/start app đã gửi. Chỉ UUID được đổi thành alias và timestamp thành THOI_DIEM_NGUON để demo ổn định. Cùng một Peer Thread: thread/start → turn/start → thread/resume → turn/start. Instructions được đọc từ instructions/peer.md ở cả hai lượt.",
    ...prompts.map((prompt, index) => "Lượt " + (index + 1) + ":\n\n```text\n" + prompt + "\n```"),
    "Lượt 2 vẫn có mục tiêu, tiêu chí, ràng buộc và quyết định hiện hành. Báo cáo dài không gửi lại; PREVIOUS_CONTEXT chứa metadata và tóm tắt do Lead cung cấp. Có regression kiểm tra payload runtime, cùng Thread, checkpoint và nguồn không bị lặp."
  ].join("\n\n") + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPeerPromptDemo().then(result => {
    const markdown = demoMarkdown(result.normalizedPrompts);
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]), markdown);
    process.stdout.write(markdown);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
