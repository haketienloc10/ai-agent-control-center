import type { AgentSession, Delivery, Message, WorkspaceConfig } from "@aacc/contracts";
import { CoordinationStore } from "./coordination-store.js";
import type { AgentRuntime } from "./codex-runtime.js";

function leadPrompt(config: WorkspaceConfig, store: CoordinationStore, delivery: Delivery): string {
  const state = store.snapshot();
  const current = state.messages.find(m => m.id === delivery.messageId)!;
  const recent = state.messages.filter(m => m.conversationId === delivery.conversationId).slice(-50);
  const originalRequest = state.messages.find(m => m.conversationId === delivery.conversationId &&
    m.from === "user")?.text ?? "";
  const peers = state.sessions.filter(s => s.conversationId === delivery.conversationId &&
    s.role === "peer").map(s => ({
    sessionId: s.id, moduleId: s.moduleId, label: s.label, status: s.status, error: s.error
  }));
  const discovery = state.sessions.filter(s => s.conversationId === delivery.conversationId &&
    s.role === "discovery").map(s => ({
    sessionId: s.id, status: s.status, error: s.error
  }));
  return [
    "Bạn là LEAD AGENT, điều phối các Peer sessions thay người dùng.",
    "Bạn ở workspace riêng, không sửa code; giao công việc cho Peer theo module.",
    "Điều phối theo sự kiện: sau khi giao việc, kết thúc Codex turn của bạn ngay. Task vẫn active.",
    "App tự gửi kết quả hoặc lỗi của Peer/Discovery cho bạn bằng event mới; không cần chờ hoặc hỏi tiến độ.",
    "TUYỆT ĐỐI không gọi send_peer chỉ để hỏi trạng thái, nhắc tiến độ hoặc yêu cầu báo cáo.",
    "TUYỆT ĐỐI không gọi send_discovery chỉ để hỏi trạng thái, nhắc tiến độ hoặc yêu cầu báo cáo.",
    "Trạng thái Peer nằm trong PEER_SESSIONS. Peer running thì không can thiệp nếu không có thay đổi công việc thực sự.",
    "Chỉ dùng send_peer để giao yêu cầu mới, sửa hoặc bổ sung công việc có nội dung cụ thể.",
    "Khi thiếu ngữ cảnh tổng quan, chủ động dùng spawn_discovery(message) để yêu cầu khám phá sơ bộ nhiều module; không bắt buộc với mọi task.",
    "Discovery là giai đoạn riêng và phải hoàn tất trước khi giao triển khai. Nếu cần Discovery, gọi spawn_discovery hoặc send_discovery TRƯỚC các công cụ Peer; sau khi tool thành công, KẾT THÚC turn ngay.",
    "TUYỆT ĐỐI không giao Peer hoặc gọi finish trong cùng Lead turn đã giao Discovery. Không chạy song song Discovery với việc triển khai; chờ event kết quả/lỗi rồi mới quyết định giao Peer.",
    "App thực thi ranh giới giai đoạn này: các tool khác trong cùng turn và các Lead turn mới khi Discovery còn pending sẽ bị từ chối.",
    "Discovery chỉ cung cấp định hướng, không thay thế bằng chứng kỹ thuật; khi cần chi tiết, giao Peer điều tra sâu.",
    "Một conversation chỉ có một Discovery session; dùng send_discovery(sessionId,message) nếu cần khảo sát bổ sung thực sự.",
    "Nếu DISCOVERY_SESSIONS đang queued/running, không nhắc tiến độ; kết thúc turn và chờ event.",
    "Discovery chỉ khả dụng khi DISCOVERY_ENABLED=true.",
    "Dùng spawn_peer để mở Peer mới. Dùng finish() CHỈ khi toàn bộ task thật sự hoàn thành.",
    "Sau khi finish() thành công, gửi báo cáo cuối bằng Codex finalText thông thường; không truyền báo cáo vào tool.",
    "Nếu còn Peer hoặc Discovery đang làm phần việc cần thiết, không gọi finish. Kết thúc turn và chờ event.",
    "GỌI các công cụ spawn_discovery, send_discovery, spawn_peer, send_peer, finish trực tiếp; không viết JSON điều phối trong reply.",
    "Mỗi event có thể chứa nhiều kết quả Discovery/Peer trong RECENT_CONVERSATION; xử lý những kết quả mới một lần.",
    "Peer không trao đổi trực tiếp với Peer khác. Mọi yêu cầu phối hợp phải qua bạn.",
    "Không tự tuyên bố test thành công nếu Peer chưa cung cấp bằng chứng.",
    "Không có approval gate hoặc workflow quality gate của app.",
    "spawn_peer(moduleId,message,label?,model?,effort?) cho phép override model/effort khi mở Peer mới.",
    "Nếu không override thì dùng Peer App Settings. Không sử dụng send_peer chỉ để đổi model/effort.",
    config.lead.instructions,
    "SETTINGS: " + JSON.stringify(store.settings()),
    "MODULES: " + JSON.stringify(config.modules.map(m => ({ id: m.id, label: m.label, path: m.path }))),
    "PEER_SESSIONS: " + JSON.stringify(peers),
    "DISCOVERY_ENABLED: " + Boolean(config.discovery && config.discovery.enabled !== false),
    "DISCOVERY_SESSIONS: " + JSON.stringify(discovery),
    "ORIGINAL_USER_REQUEST: " + JSON.stringify(originalRequest),
    "CURRENT_MESSAGE: " + JSON.stringify(current),
    "RECENT_CONVERSATION: " + JSON.stringify(recent.map(m => ({
      from: m.from, to: m.to, peerSessionId: m.peerSessionId,
      discoverySessionId: m.discoverySessionId, text: m.text
    })))
  ].join("\n\n");
}
/** Preliminary survey under Lead's direction; runtime privileges follow Peer policy. */
function discoveryPrompt(config: WorkspaceConfig, message: Message): string {
  return [
    "Bạn là DISCOVERY AGENT. Thực hiện yêu cầu khảo sát sơ bộ do Lead giao trong các module được cấu hình.",
    "Chỉ đọc có chọn lọc cấu trúc dự án, công nghệ, entry points và những file có khả năng liên quan.",
    "Không điều tra sâu call chain, không kết luận root cause, không tự lập kế hoạch triển khai hoặc phân công Peer.",
    "Không triển khai nhiệm vụ hoặc chạy build/test mặc định; không gọi tool điều phối của Lead.",
    "Phân biệt điều đã đọc xác minh với giả định; nêu rõ thông tin còn thiếu và nơi Peer nên khảo sát sâu.",
    "Báo cáo ngắn gọn cho Lead, ưu tiên đường dẫn file đã kiểm tra. Không quyết định thay Lead.",
    "Có thể nhận yêu cầu khảo sát bổ sung trong cùng Codex Thread; báo cáo kết quả và blocker về Lead.",
    "MODULES: " + JSON.stringify(config.modules.map(m => ({ id: m.id, label: m.label, path: m.path }))),
    "LEAD_MESSAGE: " + message.text
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
        session.role === "discovery" ? this.config.discovery?.cwd :
        this.config.modules.find(m => m.id === session.moduleId)?.path;
      if (!cwd) throw new Error("Module không còn trong cấu hình: " + session.moduleId);
      const prompt = session.role === "lead"
        ? leadPrompt(this.config, this.store, delivery)
        : session.role === "discovery"
          ? discoveryPrompt(this.config, input)
          : peerPrompt(this.config, session, input);
      let finished = false;
      const hooks = {
        onThread: (threadId: string) => this.store.setThread(session.id, threadId),
        onTurn: (turnId: string) => this.store.setTurn(session.id, turnId),
        ...(session.role === "lead" ? { onLeadTool: (callId: string,
          command: import("@aacc/contracts").LeadCommand) => {
          const result = this.store.routeLeadTool(
            delivery.id, callId, command, this.config.modules.map(m => m.id),
            Boolean(this.config.discovery && this.config.discovery.enabled !== false));
          if (command.type === "finish") finished = true;
          return result;
        } } : {})
      };
      const selection = session.role === "lead"
        ? this.store.settings().lead
        : session.role === "discovery"
          ? {
              // App Settings take precedence; old workspace config remains a fallback.
              model: this.store.settings().discovery.model ?? this.config.discovery?.model,
              effort: this.store.settings().discovery.effort ?? this.config.discovery?.effort
            }
          : { model: session.model, effort: session.effort };
      const workspaceRoots = session.role === "discovery"
        ? [...new Set([cwd, ...this.config.modules.map(m => m.path)])]
        : undefined;
      const output = await this.runtime.run(session, cwd, prompt, hooks, selection, workspaceRoots);
      if (session.role === "lead") {
        // finish() only updates task state; the final Codex response is persisted once.
        this.store.completeLead(delivery.id, output, finished);
      } else if (session.role === "discovery") {
        this.store.completeDiscovery(delivery.id, output);
      } else {
        this.store.completePeer(delivery.id, output);
      }
    } catch (error) {
      this.store.failDelivery(deliveryId, error instanceof Error ? error.message : String(error));
    }
  }
}
