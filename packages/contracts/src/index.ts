/** Các agent có context độc lập; Lead quyết định và chuyển giao bằng chứng tường minh. */
export interface ModuleConfig { id: string; label: string; path: string; }
export interface WorkspaceConfig {
  lead: { cwd: string };
  discovery?: { cwd: string; enabled?: boolean };
  modules: ModuleConfig[];
}
/** Giá trị bỏ trống sẽ kế thừa cấu hình Codex. */
export interface ModelSelection { model?: string; effort?: string; }
export interface AppSettings { lead: ModelSelection; peer: ModelSelection; discovery: ModelSelection; }
export interface CodexModelOption {
  id: string; displayName: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: string[];
}
export type AgentRole = "lead" | "peer" | "discovery";
export type SessionStatus = "idle" | "running" | "interrupted";
export interface Conversation {
  id: string; title: string; status: "active" | "finished";
  leadSessionId: string; generation: number; taskBrief?: TaskBrief;
  /** Decision Log append-only; quyết định hiện hành của một topic là bản ghi cuối cùng. */
  decisions?: Decision[];
  createdAt: string; updatedAt: string;
}
/** Quyết định của Lead về điều nhiều module cùng phụ thuộc. App chỉ lưu và chuyển cho Peer bị ảnh hưởng. */
export interface Decision {
  id: string; topic: string; decision: string; rationale: string;
  /** Module ID mà Peer phải tuân theo quyết định. */
  affects: string[];
  evidenceRefs: string[];
  /** Quyết định trước cùng topic bị thay thế. */
  supersedes?: string;
  createdAt: string;
}
export interface AgentSession {
  id: string; conversationId: string; role: AgentRole;
  moduleId?: string; label: string; threadId?: string; turnId?: string;
  status: SessionStatus; error?: string;
  /** Peer model/effort đóng băng khi spawn. */
  model?: string; effort?: string;
  // Deduplicate app-server tool call replay after reconnect/crash.
  handledToolCalls?: string[];
  createdAt: string; updatedAt: string;
}
export type MessageAuthor = "user" | "lead" | "peer" | "discovery" | "system";
/** Lead tự đánh giá, App chỉ lưu nội dung và không chứng thực tính đúng đắn. */
export interface TaskBrief {
  goal: string;
  acceptanceCriteria: string[];
  verified: Array<{ finding: string; evidenceRefs: string[] }>;
  preliminary: string[];
  unknowns: string[];
  nextDecision: string;
}
export interface ContextSource {
  messageId: string;
  from: MessageAuthor;
  kind: "user-request" | "discovery-preliminary" | "peer-report" | "lead-note" | "system-event";
  text: string;
  createdAt: string;
}
/** Tóm tắt do Lead viết cho nguồn đã có trong Thread, không phải App suy diễn. */
export interface PreviousContextNote { messageId: string; summary: string; }
export interface ContextReference extends Omit<ContextSource, "text"> { summary?: string; }
/** Trạng thái cốt lõi được chốt theo assignment, luôn gửi lại cho Peer. */
export interface PeerCheckpoint {
  assignmentId: string; moduleId: string; continues?: string;
  goal: string; acceptanceCriteria: string[]; constraints: string[];
}
/** Bản chụp bất biến tại thời điểm giao việc, không phụ thuộc lịch sử Thread. */
export interface ContextPacket {
  /** Peer mới: mục tiêu/tiêu chí từ Brief của Lead (goal dùng yêu cầu gốc nếu chưa có Brief). */
  peerCheckpoint?: PeerCheckpoint;
  /** Metadata và tóm tắt do Lead cung cấp cho nguồn không gửi lại nguyên văn. */
  previousContext?: ContextReference[];
  /** Vắng mặt khi Thread của session đã nhận yêu cầu gốc ở lượt trước. */
  originalRequest?: { messageId: string; text: string };
  /** Discovery/packet cũ: vắng khi chưa có Brief hoặc Brief không đổi. Peer mới dùng checkpoint gọn. */
  taskBrief?: TaskBrief;
  /** Chỉ nguồn mới; nguồn session đã có trong Thread nằm ở `omitted.sourceIds`. */
  sources: ContextSource[];
  /** Peer checkpoint: toàn bộ quyết định hiện hành áp dụng, kể cả mảng rỗng.
   * Packet cũ: chỉ những quyết định Thread chưa có. */
  decisions?: Decision[];
  expectedResult: string;
  /** Phần App không gửi lại vì đã có trong Thread của session nhận. */
  omitted?: { taskBrief?: true; sourceIds?: string[]; decisionIds?: string[] };
}
export interface Message {
  id: string; conversationId: string; from: MessageAuthor;
  to: "user" | "lead" | "peer" | "discovery";
  text: string; peerSessionId?: string; discoverySessionId?: string;
  contextPacket?: ContextPacket; createdAt: string;
}
export interface Delivery {
  id: string; conversationId: string; sessionId: string; messageId: string;
  generation: number;
  /** Frozen per-turn Lead input batch. Worker deliveries do not use this. */
  eventMessageIds?: string[];
  /** Codex acknowledged turn/start; not proof the turn completed. */
  codexTurnId?: string;
  /** Enforce one routing phase per Lead turn: either Discovery handoff or implementation. */
  routingPhase?: "discovery" | "execution";
  status: "queued" | "running" | "completed" | "interrupted" | "superseded";
  error?: string; createdAt: string; updatedAt: string;
}
export interface Snapshot {
  modules: ModuleConfig[];
  conversations: Conversation[];
  sessions: AgentSession[];
  messages: Message[];
  deliveries: Delivery[];
  settings: AppSettings;
}
export type LeadCommand =
  /** Mỗi module có một Peer: lần đầu App tạo, các lần sau dùng lại Thread của Peer đó. */
  | { type: "assign_module"; moduleId: string; message: string; expectedResult: string;
      contextRefs?: string[]; constraints?: string[]; previousContext?: PreviousContextNote[];
      model?: string; effort?: string }
  | { type: "record_decision"; topic: string; decision: string; rationale: string;
      affects: string[]; evidenceRefs?: string[] }
  | { type: "spawn_discovery"; message: string; expectedResult: string;
      contextRefs?: string[] }
  | { type: "send_discovery"; sessionId: string; message: string; expectedResult: string;
      contextRefs?: string[] }
  | { type: "update_task_brief"; brief: TaskBrief }
  | { type: "finish" };
