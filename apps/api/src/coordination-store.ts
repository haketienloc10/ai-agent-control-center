import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentSession, Conversation, Delivery, LeadCommand, LeadResponse, Message, MessageAuthor, Snapshot
} from "@aacc/contracts";

type Data = Omit<Snapshot, "modules">;
const now = () => new Date().toISOString();
const text = (value: unknown, label: string, limit = 20000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(label + " phải là chuỗi không rỗng, tối đa " + limit + " ký tự");
  }
  return value.trim();
};
function message(data: Data, conversationId: string, from: MessageAuthor,
  to: Message["to"], body: string, peerSessionId?: string): Message {
  const entry: Message = {
    id: randomUUID(), conversationId, from, to, text: body,
    ...(peerSessionId ? { peerSessionId } : {}), createdAt: now()
  };
  data.messages.push(entry);
  return entry;
}
function deliver(data: Data, conversationId: string, sessionId: string, messageId: string) {
  const entry: Delivery = {
    id: randomUUID(), conversationId, sessionId, messageId,
    status: "queued", createdAt: now(), updatedAt: now()
  };
  data.deliveries.push(entry);
  return entry;
}

/** SQLite snapshot: one atomic commit stores messages, peer sessions and pending deliveries. */
export class CoordinationStore extends EventEmitter {
  private readonly db: DatabaseSync;
  private state: Data;
  constructor(directory: string) {
    super();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Deliberately new DB; old P1–P3 workflow state is not imported or executed.
    this.db = new DatabaseSync(join(directory, "coordination.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL);");
    const row = this.db.prepare("SELECT body FROM snapshot WHERE id = 1").get() as { body: string } | undefined;
    this.state = row ? JSON.parse(row.body) as Data
      : { conversations: [], sessions: [], messages: [], deliveries: [] };
    // Never replay turns already started before a crash. Queued deliveries were not started.
    let changed = false;
    for (const delivery of this.state.deliveries) {
      if (delivery.status === "running") {
        delivery.status = "interrupted";
        delivery.error = "Backend restarted during Codex turn; not replayed";
        delivery.updatedAt = now();
        const session = this.state.sessions.find(s => s.id === delivery.sessionId);
        if (session) {
          session.status = "interrupted"; session.error = delivery.error; session.updatedAt = now();
        }
        message(this.state, delivery.conversationId, "system", "user",
          "Phiên " + (session?.label ?? delivery.sessionId) +
          " bị gián đoạn khi Backend khởi động lại. Không tự chạy lại prompt trước.");
        changed = true;
      }
    }
    if (changed) this.persist();
  }
  private persist() {
    this.db.prepare("INSERT INTO snapshot(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(JSON.stringify(this.state));
  }
  private mutate<T>(run: (data: Data) => T): T {
    const candidate = structuredClone(this.state);
    const result = run(candidate);
    this.db.prepare("INSERT INTO snapshot(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(JSON.stringify(candidate));
    this.state = candidate;
    this.emit("change");
    return result;
  }
  snapshot(): Data { return structuredClone(this.state); }
  session(id: string): AgentSession | undefined {
    const value = this.state.sessions.find(s => s.id === id);
    return value && structuredClone(value);
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
  conversation(id: string) { return this.state.conversations.find(c => c.id === id); }

  createConversation(request: string, title?: string): Conversation {
    const value = text(request, "Yêu cầu");
    return this.mutate(data => {
      const conversation: Conversation = {
        id: randomUUID(), title: title?.trim().slice(0, 120) || value.slice(0, 90),
        status: "active", leadSessionId: randomUUID(), createdAt: now(), updatedAt: now()
      };
      data.conversations.push(conversation);
      data.sessions.push({
        id: conversation.leadSessionId, conversationId: conversation.id, role: "lead",
        label: "Lead", status: "idle", createdAt: now(), updatedAt: now()
      });
      const item = message(data, conversation.id, "user", "lead", value);
      deliver(data, conversation.id, conversation.leadSessionId, item.id);
      return conversation;
    });
  }
  postUser(conversationId: string, body: string): Message {
    const value = text(body, "Tin nhắn");
    return this.mutate(data => {
      const conversation = data.conversations.find(c => c.id === conversationId);
      if (!conversation) throw new Error("Conversation not found");
      conversation.status = "active"; conversation.updatedAt = now();
      const item = message(data, conversationId, "user", "lead", value);
      deliver(data, conversationId, conversation.leadSessionId, item.id);
      return item;
    });
  }
  startDelivery(id: string): Delivery {
    return this.mutate(data => {
      const item = data.deliveries.find(d => d.id === id);
      if (!item || item.status !== "queued") throw new Error("Delivery not queued");
      const session = data.sessions.find(s => s.id === item.sessionId);
      if (!session || session.status === "running") throw new Error("Session is unavailable");
      item.status = "running"; item.updatedAt = now();
      session.status = "running"; session.error = undefined; session.updatedAt = now();
      return item;
    });
  }
  setThread(sessionId: string, threadId: string) {
    this.mutate(data => {
      const s = data.sessions.find(s => s.id === sessionId);
      if (!s) throw new Error("Session not found");
      s.threadId = threadId; s.updatedAt = now();
    });
  }
  setToolProtocol(sessionId: string, mode: "dynamic" | "json") {
    this.mutate(data => {
      const session = data.sessions.find(s => s.id === sessionId);
      if (!session || session.role !== "lead") throw new Error("Only Lead can own routing tools");
      session.toolProtocol = mode; session.updatedAt = now();
    });
  }

  /** Handle Codex host tool request once, atomically, while Lead turn is active. */
  routeLeadTool(deliveryId: string, callId: string, command: LeadCommand,
    allowedModuleIds: string[]): string {
    if (!callId.trim()) throw new Error("Missing Codex tool call ID");
    return this.mutate(data => {
      const active = data.deliveries.find(d => d.id === deliveryId);
      if (!active || active.status !== "running") throw new Error("Lead delivery is no longer active");
      const lead = data.sessions.find(s => s.id === active.sessionId);
      if (!lead || lead.role !== "lead") throw new Error("Only Lead may invoke routing tools");
      if (lead.handledToolCalls?.includes(callId)) return "Already executed (idempotent replay)";
      const conversation = data.conversations.find(c => c.id === active.conversationId)!;
      let result: string;
      if (command.type === "finish") {
        conversation.status = "finished";
        if (command.summary?.trim()) {
          message(data, conversation.id, "lead", "user", command.summary.trim());
        }
        result = "Finished conversation " + conversation.id;
      } else {
        let peer: AgentSession | undefined;
        if (command.type === "spawn_peer") {
          if (!allowedModuleIds.includes(command.moduleId)) {
            throw new Error("Module không tồn tại: " + command.moduleId);
          }
          peer = {
            id: randomUUID(), conversationId: conversation.id, role: "peer",
            moduleId: command.moduleId, label: command.label?.trim().slice(0, 100) ||
              "Peer " + command.moduleId, status: "idle",
            createdAt: now(), updatedAt: now()
          };
          data.sessions.push(peer);
        } else {
          peer = data.sessions.find(s => s.id === command.sessionId &&
            s.conversationId === conversation.id && s.role === "peer");
          if (!peer) throw new Error("Peer session không tồn tại trong conversation: " + command.sessionId);
        }
        if (!command.message.trim()) throw new Error("Peer message không được trống");
        const outbound = message(data, conversation.id, "lead", "peer", command.message.trim(), peer.id);
        deliver(data, conversation.id, peer.id, outbound.id);
        result = "Đã giao việc tới " + peer.label + " (sessionId=" + peer.id +
          "). Kết quả sẽ tự gửi lại Lead.";
      }
      lead.handledToolCalls ??= [];
      lead.handledToolCalls.push(callId);
      // Keep a bounded replay cache; records are only transport deduplication IDs.
      if (lead.handledToolCalls.length > 4096) lead.handledToolCalls.splice(0, 2048);
      conversation.updatedAt = now();
      return result;
    });
  }

  setTurn(sessionId: string, turnId: string) {
    this.mutate(data => {
      const s = data.sessions.find(s => s.id === sessionId);
      if (!s) throw new Error("Session not found");
      s.turnId = turnId; s.updatedAt = now();
    });
  }
  /** One persisted state change = completed Lead turn + its routing decisions. */
  completeLead(id: string, output: LeadResponse, allowedModuleIds: string[]): void {
    this.mutate(data => {
      const delivery = data.deliveries.find(d => d.id === id);
      if (!delivery || delivery.status !== "running") throw new Error("Lead delivery not running");
      const conversation = data.conversations.find(c => c.id === delivery.conversationId)!;
      const lead = data.sessions.find(s => s.id === delivery.sessionId)!;
      if (lead.role !== "lead") throw new Error("Only Lead may dispatch Peer messages");
      delivery.status = "completed"; delivery.updatedAt = now();
      lead.status = "idle"; lead.updatedAt = now();
      if (output.reply?.trim()) message(data, conversation.id, "lead", "user", output.reply.trim());
      // Routing errors are tool results for Lead, not hidden decisions by Backend.
      // Only the first identical error is delivered automatically to avoid
      // infinite, costly retry loops when the model repeatedly chooses a bad ID.
      const routingError = (detail: string) => {
        message(data, conversation.id, "system", "user", detail);
        const errorText = "Routing error: " + detail;
        const previous = data.messages.some(m =>
          m.conversationId === conversation.id && m.from === "system" &&
          m.to === "lead" && m.text === errorText);
        const info = message(data, conversation.id, "system", "lead", errorText);
        if (!previous) deliver(data, conversation.id, conversation.leadSessionId, info.id);
      };
      for (const command of output.commands) {
        if (command.type === "finish") {
          conversation.status = "finished";
          if (command.summary?.trim()) {
            message(data, conversation.id, "lead", "user", command.summary.trim());
          }
          continue;
        }
        let peer: AgentSession | undefined;
        if (command.type === "spawn_peer") {
          if (!allowedModuleIds.includes(command.moduleId)) {
            routingError("Lead chọn module không tồn tại: " + command.moduleId);
            continue;
          }
          peer = {
            id: randomUUID(), conversationId: conversation.id, role: "peer",
            moduleId: command.moduleId, label: command.label?.trim().slice(0, 100) ||
              "Peer " + command.moduleId,
            status: "idle", createdAt: now(), updatedAt: now()
          };
          data.sessions.push(peer);
        } else if (command.type === "send_peer") {
          peer = data.sessions.find(s => s.id === command.sessionId &&
            s.conversationId === conversation.id && s.role === "peer");
          if (!peer) {
            routingError("Lead gửi tin nhắn đến Peer session không tồn tại: " + command.sessionId);
            continue;
          }
        }
        if (!peer) continue;
        const body = command.message?.trim();
        if (!body) {
          routingError("Lead gửi tin nhắn Peer trống");
          continue;
        }
        const item = message(data, conversation.id, "lead", "peer", body, peer.id);
        deliver(data, conversation.id, peer.id, item.id);
      }
      conversation.updatedAt = now();
    });
  }
  completePeer(id: string, result: string) {
    this.mutate(data => {
      const delivery = data.deliveries.find(d => d.id === id);
      if (!delivery || delivery.status !== "running") throw new Error("Peer delivery not running");
      const session = data.sessions.find(s => s.id === delivery.sessionId)!;
      const conversation = data.conversations.find(c => c.id === delivery.conversationId)!;
      delivery.status = "completed"; delivery.updatedAt = now();
      session.status = "idle"; session.updatedAt = now();
      const item = message(data, conversation.id, "peer", "lead",
        result.trim() || "(Peer không trả về nội dung)", session.id);
      // Peer-to-Lead only; no Peer-to-Peer route exists.
      deliver(data, conversation.id, conversation.leadSessionId, item.id);
      conversation.status = "active"; conversation.updatedAt = now();
    });
  }
  failDelivery(id: string, cause: string) {
    this.mutate(data => {
      const delivery = data.deliveries.find(d => d.id === id);
      if (!delivery || delivery.status !== "running") return;
      const session = data.sessions.find(s => s.id === delivery.sessionId)!;
      const conversation = data.conversations.find(c => c.id === delivery.conversationId)!;
      delivery.status = "interrupted"; delivery.error = cause; delivery.updatedAt = now();
      session.status = "interrupted"; session.error = cause; session.updatedAt = now();
      const body = session.label + " gặp lỗi: " + cause;
      message(data, conversation.id, "system", "user", body);
      if (session.role === "peer") {
        const item = message(data, conversation.id, "system", "lead", body, session.id);
        deliver(data, conversation.id, conversation.leadSessionId, item.id);
      }
    });
  }
  close() { this.db.close(); }
}
