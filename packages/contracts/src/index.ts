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
  createdAt: string; updatedAt: string;
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
/** Bản chụp bất biến tại thời điểm giao việc, không phụ thuộc lịch sử Thread. */
export interface ContextPacket {
  originalRequest: { messageId: string; text: string };
  taskBrief?: TaskBrief;
  sources: ContextSource[];
  expectedResult: string;
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
  | { type: "spawn_peer"; moduleId: string; message: string; expectedResult: string;
      contextRefs?: string[]; label?: string; model?: string; effort?: string }
  | { type: "send_peer"; sessionId: string; message: string; expectedResult: string;
      contextRefs?: string[] }
  | { type: "spawn_discovery"; message: string; expectedResult: string;
      contextRefs?: string[] }
  | { type: "send_discovery"; sessionId: string; message: string; expectedResult: string;
      contextRefs?: string[] }
  | { type: "update_task_brief"; brief: TaskBrief }
  | { type: "finish" };
