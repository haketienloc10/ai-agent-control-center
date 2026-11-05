/** MVP: trao đổi giữa người dùng, Lead và các Peer, không có workflow gate. */
export interface ModuleConfig { id: string; label: string; path: string; }
export interface WorkspaceConfig {
  lead: { cwd: string; instructions: string };
  modules: ModuleConfig[];
}
export type AgentRole = "lead" | "peer";
export type SessionStatus = "idle" | "running" | "interrupted";
export interface Conversation {
  id: string; title: string; status: "active" | "finished";
  leadSessionId: string; generation: number; createdAt: string; updatedAt: string;
}
export interface AgentSession {
  id: string; conversationId: string; role: AgentRole;
  moduleId?: string; label: string; threadId?: string; turnId?: string;
  status: SessionStatus; error?: string;
  // Deduplicate app-server tool call replay after reconnect/crash.
  handledToolCalls?: string[];
  createdAt: string; updatedAt: string;
}
export type MessageAuthor = "user" | "lead" | "peer" | "system";
export interface Message {
  id: string; conversationId: string; from: MessageAuthor;
  to: "user" | "lead" | "peer";
  text: string; peerSessionId?: string; createdAt: string;
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
}
export type LeadCommand =
  | { type: "spawn_peer"; moduleId: string; message: string; label?: string }
  | { type: "send_peer"; sessionId: string; message: string }
  | { type: "finish"; summary?: string };
