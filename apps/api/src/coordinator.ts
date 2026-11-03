import type { AgentSession, Delivery, Message, WorkspaceConfig } from "@aacc/contracts";
import { CoordinationStore } from "./coordination-store.js";
import { parseLeadResponse } from "./lead-protocol.js";
import type { AgentRuntime } from "./codex-runtime.js";

function leadPrompt(config: WorkspaceConfig, store: CoordinationStore, delivery: Delivery): string {
  const state = store.snapshot();
  const current = state.messages.find(m => m.id === delivery.messageId)!;
  const recent = state.messages.filter(m => m.conversationId === delivery.conversationId).slice(-50);
  const peers = state.sessions.filter(s => s.conversationId === delivery.conversationId &&
    s.role === "peer").map(s => ({
    sessionId: s.id, moduleId: s.moduleId, label: s.label, status: s.status, error: s.error
  }));
  return [
    "Bạn là LEAD AGENT, người duy nhất điều phối các Peer sessions thay người dùng.",
    "Bạn làm việc trong workspace riêng. Không tự sửa code; hãy giao Peer theo module.",
    "Peer KHÔNG giao tiếp trực tiếp với nhau. Mọi thông tin, câu hỏi, blocker và kết quả đều qua bạn.",
    "Bạn quyết định tạo bao nhiêu Peer, gửi bổ sung hay làm lại bao nhiêu lần, và khi nào hoàn thành.",
    "Không có approval gate, acceptance gate, DAG hoặc Final Review bắt buộc từ app.",
    "Để giao việc, trả về JSON với hai trường: reply (thông báo tùy chọn gửi user), commands (mảng hành động).",
    "Hành động hợp lệ:",
    JSON.stringify({
      reply: "Tôi đang giao Peer Web thực hiện",
      commands: [{ type: "spawn_peer", moduleId: "web", label: "README Web",
        message: "Đọc source module web và tạo README.md đúng với dự án" }]
    }),
    "Để tiếp tục Peer đã có: {type:\"send_peer\",sessionId:\"<session-id>\",message:\"...\"}.",
    "Để kết thúc công việc: {type:\"finish\",summary:\"...\"}.",
    "Chỉ dùng moduleId và sessionId có thật trong REGISTRY. Có thể gửi nhiều hành động một lần.",
    "Sau khi Peer hoàn thành, app tự gửi kết quả cho bạn trong cùng Lead Thread.",
    "Không tự nhận file đã tạo thành công trước khi Peer báo kết quả; kiểm tra bằng chứng và tự quyết định.",
    "Không cần gửi JSON kế hoạch, review checklist hoặc phán quyết pass/fail.",
    config.lead.instructions,
    "MODULES: " + JSON.stringify(config.modules.map(m => ({ id: m.id, label: m.label, path: m.path }))),
    "PEER_SESSIONS: " + JSON.stringify(peers),
    "CURRENT_MESSAGE: " + JSON.stringify(current),
    "RECENT_CONVERSATION: " + JSON.stringify(recent.map(m => ({
      from: m.from, to: m.to, peerSessionId: m.peerSessionId, text: m.text
    })))
  ].join("\n\n");
}
function peerPrompt(config: WorkspaceConfig, session: AgentSession, message: Message): string {
  return [
    "Bạn là Peer Agent trong module " + session.moduleId + ".",
    "Thực hiện yêu cầu từ Lead trực tiếp trong thư mục module hiện tại.",
    "Có thể nhận nhiều lượt yêu cầu trong cùng Codex Thread; giữ ngữ cảnh session.",
    "Mọi thông tin cần trao đổi với Agent khác phải báo lại Lead, KHÔNG giao tiếp Peer-to-Peer.",
    "Trả kết quả dạng văn bản tự nhiên: công việc đã làm, file đã sửa, test thực tế và blocker.",
    "Không được tự tuyên bố test passed nếu chưa thực sự chạy.",
    "Nếu thiếu thông tin, đặt câu hỏi cho Lead thay vì tự giao việc cho Peer khác.",
    "WORKSPACE MODULE: " + config.modules.find(m => m.id === session.moduleId)?.path,
    "LEAD MESSAGE: " + message.text
  ].join("\n\n");
}

/** Scheduling is technical plumbing, not a workflow quality gate. */
export class Coordinator {
  private readonly active = new Set<string>();
  private scheduled = false;
  constructor(private readonly config: WorkspaceConfig, private readonly store: CoordinationStore,
    private readonly runtime: AgentRuntime, private readonly concurrency = 4) {
    store.on("change", () => this.schedule());
    this.schedule(); // Queued but never-started deliveries are safe after restart.
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump() {
    for (const delivery of this.store.queued()) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(delivery.sessionId)) continue;
      const session = this.store.session(delivery.sessionId);
      if (!session || session.status === "running") continue;
      this.active.add(session.id);
      try { this.store.startDelivery(delivery.id); }
      catch { this.active.delete(session.id); continue; }
      void this.execute(delivery.id).finally(() => {
        this.active.delete(session.id);
        this.schedule();
      });
    }
  }
  private async execute(deliveryId: string) {
    try {
      const delivery = this.store.delivery(deliveryId)!;
      const session = this.store.session(delivery.sessionId)!;
      const input = this.store.input(delivery.id)!;
      const cwd = session.role === "lead" ? this.config.lead.cwd :
        this.config.modules.find(m => m.id === session.moduleId)?.path;
      if (!cwd) throw new Error("Module không còn trong cấu hình: " + session.moduleId);
      const prompt = session.role === "lead"
        ? leadPrompt(this.config, this.store, delivery)
        : peerPrompt(this.config, session, input);
      const output = await this.runtime.run(session, cwd, prompt, {
        onThread: threadId => this.store.setThread(session.id, threadId),
        onTurn: turnId => this.store.setTurn(session.id, turnId)
      });
      if (session.role === "lead") {
        this.store.completeLead(delivery.id, parseLeadResponse(output),
          this.config.modules.map(m => m.id));
      } else {
        this.store.completePeer(delivery.id, output);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.store.failDelivery(deliveryId, reason);
    }
  }
}
