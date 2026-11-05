import type { AgentSession, Delivery, Message, WorkspaceConfig } from "@aacc/contracts";
import { CoordinationStore } from "./coordination-store.js";
import type { AgentRuntime } from "./codex-runtime.js";

function leadPrompt(config: WorkspaceConfig, store: CoordinationStore, delivery: Delivery): string {
  const state = store.snapshot();
  const events = store.leadInputs(delivery.id);
  const peers = state.sessions.filter(s => s.conversationId === delivery.conversationId &&
    s.role === "peer").map(s => ({
    sessionId: s.id, moduleId: s.moduleId, label: s.label, status: s.status, error: s.error
  }));
  return [
    "Bạn là LEAD AGENT, điều phối các Peer sessions thay người dùng.",
    "Bạn ở workspace riêng, không sửa code; giao công việc cho Peer theo module.",
    "Điều phối theo sự kiện: sau khi giao việc, kết thúc Codex turn của bạn ngay. Task vẫn active.",
    "App tự gửi kết quả hoặc lỗi của Peer cho bạn bằng một event mới; không cần chờ hoặc hỏi Peer.",
    "TUYỆT ĐỐI không gọi send_peer chỉ để hỏi trạng thái, nhắc tiến độ hoặc yêu cầu báo cáo.",
    "Trạng thái Peer nằm trong PEER_SESSIONS. Peer running thì không can thiệp nếu không có thay đổi công việc thực sự.",
    "Chỉ dùng send_peer để giao yêu cầu mới, sửa hoặc bổ sung công việc có nội dung cụ thể.",
    "Dùng spawn_peer để mở Peer mới. Dùng finish() CHỈ khi toàn bộ task thật sự hoàn thành.",
    "Sau khi finish() thành công, gửi báo cáo cuối bằng Codex finalText thông thường; không truyền báo cáo vào tool.",
    "Nếu còn Peer đang làm phần việc cần thiết, không gọi finish. Kết thúc turn và chờ event.",
    "GỌI các công cụ spawn_peer, send_peer, finish trực tiếp để điều phối; không viết JSON điều phối trong reply.",
    "NEW_EVENTS chỉ chứa các sự kiện mới được chuyển đến turn này. Có thể có nhiều kết quả Peer; xử lý từng event một lần.",
    "Peer không trao đổi trực tiếp với Peer khác. Mọi yêu cầu phối hợp phải qua bạn.",
    "Không tự tuyên bố test thành công nếu Peer chưa cung cấp bằng chứng.",
    "Không có approval gate hoặc workflow quality gate của app.",
    "spawn_peer(moduleId,message,label?,model?,effort?) cho phép override model/effort khi mở Peer mới.",
    "Nếu không override thì dùng Peer App Settings. Không sử dụng send_peer chỉ để đổi model/effort.",
    config.lead.instructions,
    "SETTINGS: " + JSON.stringify(store.settings()),
    "MODULES: " + JSON.stringify(config.modules.map(m => ({ id: m.id, label: m.label, path: m.path }))),
    "PEER_SESSIONS: " + JSON.stringify(peers),
    "NEW_EVENTS: " + JSON.stringify(events.map(m => ({
      id: m.id, from: m.from, peerSessionId: m.peerSessionId, text: m.text
    })))
  ].join("\n\n");
}
function peerPrompt(config: WorkspaceConfig, session: AgentSession, message: Message): string {
  return [
    "Bạn là Peer Agent trong module " + session.moduleId + ".",
    "Thực hiện yêu cầu từ Lead trực tiếp trong thư mục module hiện tại.",
    "Có thể nhận yêu cầu bổ sung trong cùng Codex Thread sau khi kết thúc lượt trước.",
    "Không trao đổi trực tiếp Peer-to-Peer; gửi kết quả, lỗi hoặc blocker về Lead.",
    "Báo cáo việc đã làm, file đã sửa, test thực tế và blocker khi kết thúc turn.",
    "Không tự tuyên bố test đạt nếu chưa chạy.",
    "WORKSPACE MODULE: " + config.modules.find(m => m.id === session.moduleId)?.path,
    "LEAD MESSAGE: " + message.text
  ].join("\n\n");
}

/** Queued event deliveries wake idle sessions; no Lead polling turn is scheduled. */
export class Coordinator {
  private readonly active = new Set<string>();
  private scheduled = false;
  constructor(private readonly config: WorkspaceConfig, private readonly store: CoordinationStore,
    private readonly runtime: AgentRuntime, private readonly concurrency = 4) {
    store.on("change", () => this.schedule());
    this.schedule();
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
      let finished = false;
      const hooks = {
        onThread: (threadId: string) => this.store.setThread(session.id, threadId),
        onTurn: (turnId: string) => this.store.setTurn(session.id, turnId),
        onLeadTool: (callId: string, command: import("@aacc/contracts").LeadCommand) => {
          const result = this.store.routeLeadTool(
            delivery.id, callId, command, this.config.modules.map(m => m.id));
          if (command.type === "finish") finished = true;
          return result;
        }
      };
      const selection = session.role === "lead"
        ? this.store.settings().lead
        : { model: session.model, effort: session.effort };
      const output = await this.runtime.run(session, cwd, prompt, hooks, selection);
      if (session.role === "lead") {
        // finish() only updates task state; the final Codex response is persisted once.
        this.store.completeLead(delivery.id, output, finished);
      } else {
        this.store.completePeer(delivery.id, output);
      }
    } catch (error) {
      this.store.failDelivery(deliveryId, error instanceof Error ? error.message : String(error));
    }
  }
}
