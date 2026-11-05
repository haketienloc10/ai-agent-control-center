import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentSession, AppSettings, Conversation, Delivery, LeadCommand, Message, MessageAuthor, ModelSelection, Snapshot
} from "@aacc/contracts";

type Data = Omit<Snapshot, "modules">;
const now = () => new Date().toISOString();
const emptySettings = (): AppSettings => ({ lead: {}, peer: {} });
/** Validate transport values; Codex decides whether a model supports the selection. */
export function normalizeSelection(value: unknown): ModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model selection phải là object");
  }
  const input = value as Record<string, unknown>;
  const selection: ModelSelection = {};
  for (const key of ["model", "effort"] as const) {
    const item = input[key];
    if (item === undefined || item === null || item === "") continue;
    const limit = key === "model" ? 128 : 32;
    if (typeof item !== "string" || item.length > limit ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._+:/-]*$/.test(item)) {
      throw new Error(key + " không hợp lệ");
    }
    selection[key] = item;
  }
  return selection;
}
export function normalizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("App Settings phải là object");
  }
  const input = value as Record<string, unknown>;
  return { lead: normalizeSelection(input.lead), peer: normalizeSelection(input.peer) };
}
const text = (value: unknown, label: string, limit = 20000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(label + " phải là chuỗi không rỗng, tối đa " + limit + " ký tự");
  }
  return value.trim();
};
function message(data: Data, conversationId: string, from: MessageAuthor,
  to: Message["to"], body: string, agentSessionId?: string): Message {
  const entry: Message = {
    id: randomUUID(), conversationId, from, to, text: body,
    ...(agentSessionId ? (from === "discovery"
      ? { discoverySessionId: agentSessionId } : { peerSessionId: agentSessionId }) : {}),
    createdAt: now()
  };
  data.messages.push(entry);
  return entry;
}
function deliver(data: Data, conversationId: string, sessionId: string, messageId: string) {
  const entry: Delivery = {
    id: randomUUID(), conversationId, sessionId, messageId,
    generation: data.conversations.find(c => c.id === conversationId)?.generation ?? 0,
    status: "queued", createdAt: now(), updatedAt: now()
  };
  data.deliveries.push(entry);
  return entry;
}

/** Một Peer event chỉ đánh thức Lead nếu chưa có Lead delivery đang chờ. */
function wakeLead(data: Data, conversation: Conversation, messageId: string): void {
  if (conversation.status !== "active") return;
  const pending = data.deliveries.some(d => d.conversationId === conversation.id &&
    d.sessionId === conversation.leadSessionId && d.status === "queued");
  if (!pending) deliver(data, conversation.id, conversation.leadSessionId, messageId);
}

function finishConversation(data: Data, conversation: Conversation): void {
  if (conversation.status === "finished") throw new Error("Task đã hoàn thành");
  conversation.status = "finished";
  // Invalidate events from Peer turns started before this finish, even after user reopens.
  conversation.generation = (conversation.generation ?? 0) + 1;
  conversation.updatedAt = now();
  // Work not yet started must not execute after finish. Running Peer may still report,
  // but its report is recorded without waking Lead.
  for (const pending of data.deliveries) {
    if (pending.conversationId === conversation.id && pending.status === "queued") {
      pending.status = "superseded";
      pending.updatedAt = now();
    }
  }
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
      : { conversations: [], sessions: [], messages: [], deliveries: [], settings: emptySettings() };
    const missingSettings = !this.state.settings;
    this.state.settings ??= emptySettings();
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
        // Discovery is not replayed after a crash; unblock the first Lead turn.
        if (session?.role === "discovery") {
          const conversation = this.state.conversations.find(c => c.id === delivery.conversationId)!;
          if (conversation.status === "active" &&
              (delivery.generation ?? 0) === (conversation.generation ?? 0)) {
            const item = message(this.state, conversation.id, "system", "lead",
              "Discovery bị gián đoạn sau restart; chưa có báo cáo sơ bộ. Lead cần tự đánh giá hoặc giao Peer khảo sát.");
            wakeLead(this.state, conversation, item.id);
          }
        }
        changed = true;
      }
    }
    if (changed || missingSettings) this.persist();
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

  createConversation(request: string, title?: string, discover = false): Conversation {
    const value = text(request, "Yêu cầu");
    return this.mutate(data => {
      const conversation: Conversation = {
        id: randomUUID(), title: title?.trim().slice(0, 120) || value.slice(0, 90),
        status: "active", leadSessionId: randomUUID(), generation: 0,
        createdAt: now(), updatedAt: now()
      };
      data.conversations.push(conversation);
      data.sessions.push({
        id: conversation.leadSessionId, conversationId: conversation.id, role: "lead",
        label: "Lead", status: "idle", createdAt: now(), updatedAt: now()
      });
      const item = message(data, conversation.id, "user", "lead", value);
      if (discover) {
        const discoverySessionId = randomUUID();
        data.sessions.push({
          id: discoverySessionId, conversationId: conversation.id, role: "discovery",
          label: "Discovery", status: "idle", createdAt: now(), updatedAt: now()
        });
        deliver(data, conversation.id, discoverySessionId, item.id);
      } else {
        deliver(data, conversation.id, conversation.leadSessionId, item.id);
      }
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
      // Keep the first Lead turn behind an in-flight Discovery, including user follow-ups.
      const discovering = data.deliveries.some(d => d.conversationId === conversationId &&
        (d.status === "queued" || d.status === "running") &&
        data.sessions.some(s => s.id === d.sessionId && s.role === "discovery"));
      if (!discovering) deliver(data, conversationId, conversation.leadSessionId, item.id);
      return item;
    });
  }
  startDelivery(id: string): Delivery {
    return this.mutate(data => {
      const item = data.deliveries.find(d => d.id === id);
      if (!item || item.status !== "queued") throw new Error("Delivery not queued");
      const session = data.sessions.find(s => s.id === item.sessionId);
      if (!session || session.status === "running") throw new Error("Session is unavailable");
      const conversation = data.conversations.find(c => c.id === item.conversationId);
      if (!conversation || conversation.status !== "active" ||
        (item.generation ?? 0) !== (conversation.generation ?? 0)) {
        throw new Error("Delivery thuộc task đã kết thúc");
      }
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
      if (conversation.status !== "active") throw new Error("Task đã hoàn thành");
      let result: string;
      if (command.type === "finish") {
        finishConversation(data, conversation);
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
            ...normalizeSelection({
              model: command.model ?? data.settings.peer.model,
              effort: command.effort ?? data.settings.peer.effort
            }),
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
  /** End one Lead turn; task remains active unless finish was called explicitly. */
  completeLead(id: string, reply: string, finished = false): void {
    this.mutate(data => {
      const delivery = data.deliveries.find(d => d.id === id);
      if (!delivery || delivery.status !== "running") throw new Error("Lead delivery not running");
      const lead = data.sessions.find(s => s.id === delivery.sessionId)!;
      const conversation = data.conversations.find(c => c.id === delivery.conversationId)!;
      if (lead.role !== "lead") throw new Error("Only Lead may send Lead replies");
      delivery.status = "completed"; delivery.updatedAt = now();
      lead.status = "idle"; lead.updatedAt = now();
      // A finished turn keeps its normal Codex finalText; an empty finalText gets one fallback.
      // Other turns still cannot publish replies after the task was finished.
      if (finished || conversation.status === "active") {
        const body = reply.trim() || (finished ? "Task đã hoàn thành." : "");
        if (body) message(data, conversation.id, "lead", "user", body.slice(0, 20000));
      }
      conversation.updatedAt = now();
    });
  }
  /** Discovery only reports initial context; Lead alone decides whether deeper Peer investigation is needed. */
  completeDiscovery(id: string, result: string): void {
    this.mutate(data => {
      const delivery = data.deliveries.find(d => d.id === id);
      if (!delivery || delivery.status !== "running") throw new Error("Discovery delivery not running");
      const session = data.sessions.find(s => s.id === delivery.sessionId)!;
      if (session.role !== "discovery") throw new Error("Only Discovery may complete discovery");
      const conversation = data.conversations.find(c => c.id === delivery.conversationId)!;
      delivery.status = "completed"; delivery.updatedAt = now();
      session.status = "idle"; session.updatedAt = now();
      const item = message(data, conversation.id, "discovery", "lead",
        result.trim() || "(Discovery không cung cấp báo cáo sơ bộ)", session.id);
      if (conversation.status === "active" &&
          (delivery.generation ?? 0) === (conversation.generation ?? 0)) {
        wakeLead(data, conversation, item.id);
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
      if (conversation.status === "active" &&
        (delivery.generation ?? 0) === (conversation.generation ?? 0)) {
        wakeLead(data, conversation, item.id);
      }
      conversation.updatedAt = now();
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
      if (conversation.status === "active" &&
        (delivery.generation ?? 0) === (conversation.generation ?? 0)) {
        message(data, conversation.id, "system", "user", body);
        if (session.role === "peer" || session.role === "discovery") {
          const item = message(data, conversation.id, "system", "lead",
            session.role === "discovery"
              ? body + ". Lead tiếp tục không có báo cáo sơ bộ; có thể giao Peer khảo sát."
              : body, session.role === "peer" ? session.id : undefined);
          wakeLead(data, conversation, item.id);
        }
      } else if (session.role === "lead" && conversation.status === "finished") {
        // The finish tool succeeded, but the remaining Codex turn failed before finalText.
        message(data, conversation.id, "system", "user",
          "Task đã được đánh dấu hoàn thành nhưng Codex không tạo được báo cáo cuối. " + body);
      }
    });
  }
  close() { this.db.close(); }
}
