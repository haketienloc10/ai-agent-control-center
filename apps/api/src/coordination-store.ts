import { EventEmitter } from "node:events";
import type { AgentSession, AppSettings, Conversation, Delivery, LeadCommand, Message } from "@aacc/contracts";
import { CoordinationRepository } from "./coordination-repository.js";
import {
  completeDiscovery, completeLead, completePeer, createConversation, failDelivery, postUser,
  recordHandoffPrompt, recoverRunningDeliveries, setThread, setTurn, startDelivery
} from "./coordination-lifecycle.js";
import { handleLeadCommand } from "./lead-commands.js";
import { normalizeSettings } from "./coordination-settings.js";
import type { Data } from "./coordination-state.js";

export { normalizeSelection, normalizeSettings } from "./coordination-settings.js";

/** Facade giữ API hiện tại; chỉ phát change sau khi commit SQLite thành công. */
export class CoordinationStore extends EventEmitter {
  private readonly repository: CoordinationRepository;

  constructor(directory: string) {
    super();
    this.repository = new CoordinationRepository(directory);
    this.repository.recover(recoverRunningDeliveries);
  }

  private get state(): Data { return this.repository.read(); }

  private mutate<T>(run: (data: Data) => T): T {
    const result = this.repository.mutate(run);
    this.emit("change");
    return result;
  }
  snapshot(): Data { return this.repository.snapshot(); }
  /** Ghi cùng snapshot SQLite; lịch sử cũ không được dựng lại thành prompt đã gửi. */
  recordHandoffPrompt(deliveryId: string, prompt: string): string {
    return this.mutate(data => recordHandoffPrompt(data, deliveryId, prompt));
  }
  settings(): AppSettings { return structuredClone(this.state.settings); }
  updateSettings(input: unknown): AppSettings {
    const settings = normalizeSettings(input);
    return this.mutate(data => {
      data.settings = settings;
      return structuredClone(settings);
    });
  }
  session(id: string): AgentSession | undefined {
    const value = this.state.sessions.find(s => s.id === id);
    return value && structuredClone(value);
  }
  /** Lead chỉ thấy metadata của agent; tin nhắn được chuyển qua NEW_EVENTS. */
  agentSessions(conversationId: string, role: AgentSession["role"]): AgentSession[] {
    return this.state.sessions.filter(s => s.conversationId === conversationId &&
      s.role === role).map(s => structuredClone(s));
  }
  queued(): Delivery[] { return this.state.deliveries.filter(d => d.status === "queued").map(d => ({ ...d })); }
  delivery(id: string): Delivery | undefined {
    const found = this.state.deliveries.find(d => d.id === id);
    return found && { ...found };
  }
  input(id: string): Message | undefined {
    const delivery = this.state.deliveries.find(d => d.id === id);
    const found = this.state.messages.find(m => m.id === delivery?.messageId);
    return found && { ...found };
  }
  /** Chỉ đọc event đầu vào đã lưu của Lead delivery này. */
  leadInputs(id: string): Message[] {
    const delivery = this.state.deliveries.find(d => d.id === id);
    const conversation = this.state.conversations.find(c => c.id === delivery?.conversationId);
    if (!delivery || !conversation || delivery.sessionId !== conversation.leadSessionId) {
      throw new Error("Not a Lead delivery");
    }
    const ids = delivery.eventMessageIds;
    if (!ids) throw new Error("Lead delivery thiếu eventMessageIds");
    const requested = new Set(ids);
    const byId = new Map(this.state.messages.filter(m => requested.has(m.id))
      .map(m => [m.id, m]));
    return ids.map(messageId => {
      const item = byId.get(messageId);
      if (!item || item.conversationId !== conversation.id || item.to !== "lead") {
        throw new Error("Invalid Lead event message: " + messageId);
      }
      return { ...item };
    });
  }
  conversation(id: string) { return this.state.conversations.find(c => c.id === id); }

  createConversation(request: string, title?: string): Conversation {
    return this.mutate(data => createConversation(data, request, title));
  }
  postUser(conversationId: string, body: string): Message {
    return this.mutate(data => postUser(data, conversationId, body));
  }
  startDelivery(id: string): Delivery {
    return this.mutate(data => startDelivery(data, id));
  }
  setThread(sessionId: string, threadId: string): void {
    return this.mutate(data => setThread(data, sessionId, threadId));
  }
  /** Xử lý Codex host tool một lần, nguyên tử, khi Lead turn còn active. */
  routeLeadTool(deliveryId: string, callId: string, command: LeadCommand,
    allowedModuleIds: string[], discoveryEnabled = false): string {
    if (!callId.trim()) throw new Error("Missing Codex tool call ID");
    return this.mutate(data => handleLeadCommand(data, deliveryId, callId, command,
      allowedModuleIds, discoveryEnabled));
  }

  setTurn(sessionId: string, turnId: string): void {
    return this.mutate(data => setTurn(data, sessionId, turnId));
  }
  /** Kết thúc Lead turn; task vẫn active nếu chưa gọi finish. */
  completeLead(id: string, reply: string, finished = false): void {
    return this.mutate(data => completeLead(data, id, reply, finished));
  }
  /** Discovery báo cáo sơ bộ; Lead quyết định có cần điều tra sâu hơn không. */
  completeDiscovery(id: string, result: string): void {
    return this.mutate(data => completeDiscovery(data, id, result));
  }

  completePeer(id: string, result: string): void {
    return this.mutate(data => completePeer(data, id, result));
  }
  failDelivery(id: string, cause: string): void {
    return this.mutate(data => failDelivery(data, id, cause));
  }
  close() { this.repository.close(); }
}
