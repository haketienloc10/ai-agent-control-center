/** MVP: trao đổi giữa người dùng, Lead và các Peer, không có workflow gate. */
export interface ModuleConfig { id: string; label: string; path: string; }
export interface WorkspaceConfig {
  lead: { cwd: string; instructions: string };
  discovery?: { cwd: string; enabled?: boolean; model?: string; effort?: string };
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
  leadSessionId: string; generation: number; createdAt: string; updatedAt: string;
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
export interface Message {
  id: string; conversationId: string; from: MessageAuthor;
  to: "user" | "lead" | "peer" | "discovery";
  text: string; peerSessionId?: string; discoverySessionId?: string; createdAt: string;
}
export interface Delivery {
  id: string; conversationId: string; sessionId: string; messageId: string;
  generation: number;
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
  | { type: "spawn_peer"; moduleId: string; message: string; label?: string;
      model?: string; effort?: string }
  | { type: "send_peer"; sessionId: string; message: string }
  | { type: "spawn_discovery"; message: string }
  | { type: "send_discovery"; sessionId: string; message: string }
  | { type: "finish" };
