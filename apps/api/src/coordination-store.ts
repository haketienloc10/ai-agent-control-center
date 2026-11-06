import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentSession, AppSettings, ContextPacket, ContextSource, Conversation, Decision, Delivery, LeadCommand,
  Message, MessageAuthor, ModelSelection, Snapshot, TaskBrief
} from "@aacc/contracts";

type Data = Omit<Snapshot, "modules">;
const now = () => new Date().toISOString();
const emptySettings = (): AppSettings => ({ lead: {}, peer: {}, discovery: {} });
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
  return {
    lead: normalizeSelection(input.lead),
    peer: normalizeSelection(input.peer),
    discovery: normalizeSelection(input.discovery ?? {})
  };
}
const text = (value: unknown, label: string, limit = 20000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(label + " phải là chuỗi không rỗng, tối đa " + limit + " ký tự");
  }
  return value.trim();
};
function message(data: Data, conversationId: string, from: MessageAuthor,
  to: Message["to"], body: string, agentSessionId?: string, contextPacket?: ContextPacket): Message {
  const entry: Message = {
    id: randomUUID(), conversationId, from, to, text: body,
    ...(agentSessionId ? (data.sessions.some(s => s.id === agentSessionId &&
        s.role === "discovery")
      ? { discoverySessionId: agentSessionId } : { peerSessionId: agentSessionId }) : {}),
    ...(contextPacket ? { contextPacket } : {}),
    createdAt: now()
  };
  data.messages.push(entry);
  return entry;
}
/** Resolve selected evidence strictly within the same conversation, before queueing.
 * Refs in `skip` are still validated but not copied again. */
function contextSources(data: Data, conversationId: string, refs: string[] = [],
  skip: ReadonlySet<string> = new Set()): ContextSource[] {
  if (!Array.isArray(refs) || refs.length > 8 || new Set(refs).size !== refs.length) {
    throw new Error("contextRefs cần tối đa 8 message IDs không trùng");
  }
  let total = 0;
  const sources: ContextSource[] = [];
  for (const ref of refs) {
    if (typeof ref !== "string" || !ref.trim()) throw new Error("contextRefs phải là message IDs");
    const item = data.messages.find(m => m.id === ref && m.conversationId === conversationId);
    if (!item) throw new Error("contextRef không thuộc conversation hoặc không tồn tại: " + ref);
    if (skip.has(ref)) continue;
    total += item.text.length;
    if (total > 30000) throw new Error("contextRefs vượt giới hạn 30000 ký tự; Lead cần chọn nguồn liên quan hơn");
    const kind: ContextSource["kind"] = item.from === "discovery" ? "discovery-preliminary" :
      item.from === "peer" ? "peer-report" :
      item.from === "user" ? "user-request" :
      item.from === "lead" ? "lead-note" : "system-event";
    sources.push({ messageId: item.id, from: item.from, kind, text: item.text,
      createdAt: item.createdAt });
  }
  return sources;
}

/** What a worker Thread already holds. Only completed turns count: an interrupted handoff
 * may not have reached the Thread, so it is sent again in full. */
function threadKnowledge(data: Data, session: AgentSession) {
  const messageIds = new Set<string>();
  const decisionIds = new Set<string>();
  let hasRequest = false;
  let brief: string | undefined;
  for (const delivery of data.deliveries) {
    if (delivery.sessionId !== session.id || delivery.status !== "completed") continue;
    const packet = data.messages.find(m => m.id === delivery.messageId)?.contextPacket;
    if (!packet) continue;
    messageIds.add(delivery.messageId);
    if (packet.originalRequest) { hasRequest = true; messageIds.add(packet.originalRequest.messageId); }
    if (packet.taskBrief) brief = JSON.stringify(packet.taskBrief);
    for (const source of packet.sources) messageIds.add(source.messageId);
    for (const decision of packet.decisions ?? []) decisionIds.add(decision.id);
  }
  // The worker's own reports were produced inside that Thread.
  for (const m of data.messages) {
    if (m.from === session.role && (m.peerSessionId === session.id ||
      m.discoverySessionId === session.id)) messageIds.add(m.id);
  }
  return { messageIds, decisionIds, hasRequest, brief };
}

/** Current decision per topic: the latest record wins. */
function currentDecisions(conversation: Conversation): Decision[] {
  const byTopic = new Map<string, Decision>();
  for (const decision of conversation.decisions ?? []) byTopic.set(decision.topic, decision);
  return [...byTopic.values()];
}

/** Build the delta handoff for `target`: no field the target Thread already holds is resent. */
function assignmentPacket(data: Data, conversation: Conversation,
  command: Extract<LeadCommand, { message: string }>, target: AgentSession): ContextPacket {
  const original = data.messages.find(m => m.conversationId === conversation.id &&
    m.from === "user");
  if (!original) throw new Error("Conversation không có yêu cầu gốc");
  const expectedResult = text(command.expectedResult, "expectedResult", 4000);
  const known = threadKnowledge(data, target);
  // The original request is always attached by the App, never as a duplicate source.
  const skip = new Set([...known.messageIds, original.id]);
  const refs = command.contextRefs ?? [];
  const skippedIds = refs.filter(ref => skip.has(ref));
  const brief = conversation.taskBrief;
  const briefUnchanged = Boolean(brief) && known.brief === JSON.stringify(brief);
  // Decisions bind module owners only; Discovery is a preliminary survey.
  const binding = target.role === "peer" ? currentDecisions(conversation)
    .filter(d => d.affects.includes(target.moduleId!)) : [];
  const newDecisions = binding.filter(d => !known.decisionIds.has(d.id));
  const knownDecisionIds = binding.filter(d => known.decisionIds.has(d.id)).map(d => d.id);
  return {
    ...(known.hasRequest ? {} : { originalRequest: { messageId: original.id, text: original.text } }),
    ...(brief && !briefUnchanged ? { taskBrief: structuredClone(brief) } : {}),
    sources: contextSources(data, conversation.id, refs, skip),
    ...(newDecisions.length ? { decisions: structuredClone(newDecisions) } : {}),
    expectedResult,
    ...(briefUnchanged || skippedIds.length || knownDecisionIds.length ? { omitted: {
      ...(briefUnchanged ? { taskBrief: true as const } : {}),
      ...(skippedIds.length ? { sourceIds: skippedIds } : {}),
      ...(knownDecisionIds.length ? { decisionIds: knownDecisionIds } : {})
    } } : {})
  };
}
/** Tell Lead what App did not resend, so Lead does not repeat it in the next message. */
function omissionNote(packet: ContextPacket): string {
  const ids = packet.omitted?.sourceIds;
  return ids?.length ? " Không gửi lại " + ids.length + " nguồn đã có trong context của worker: " +
    ids.join(", ") + "." : "";
}

function checkTaskBrief(data: Data, conversation: Conversation, brief: TaskBrief): void {
  if (!brief || typeof brief !== "object") throw new Error("Task Brief không hợp lệ");
  text(brief.goal, "Task Brief goal", 5000);
  text(brief.nextDecision, "Task Brief nextDecision", 3000);
  const checkItems = (items: string[], name: string) => {
    if (!Array.isArray(items) || items.length > 20) throw new Error(name + " phải là mảng tối đa 20 phần tử");
    for (const value of items) text(value, name, 2000);
  };
  checkItems(brief.acceptanceCriteria, "acceptanceCriteria");
  checkItems(brief.preliminary, "preliminary");
  checkItems(brief.unknowns, "unknowns");
  if (!Array.isArray(brief.verified) || brief.verified.length > 20) throw new Error("verified không hợp lệ");
  for (const item of brief.verified) {
    text(item.finding, "verified finding", 2000);
    if (!Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length) {
      throw new Error("verified finding bắt buộc có evidenceRefs");
    }
    const sources = contextSources(data, conversation.id, item.evidenceRefs);
    if (sources.some(source => source.kind === "discovery-preliminary" ||
      source.kind === "lead-note")) {
      throw new Error("Không thể coi báo cáo sơ bộ hoặc nhận định Lead là bằng chứng verified");
    }
  }
}
/** Append to the Decision Log. App stores and forwards; it never judges the decision. */
function recordDecision(data: Data, conversation: Conversation,
  command: Extract<LeadCommand, { type: "record_decision" }>, allowedModuleIds: string[]): string {
  const topic = text(command.topic, "topic", 200);
  if (!Array.isArray(command.affects) || !command.affects.length ||
    new Set(command.affects).size !== command.affects.length) {
    throw new Error("affects cần danh sách module ID không rỗng, không trùng");
  }
  const unknown = command.affects.filter(id => !allowedModuleIds.includes(id));
  if (unknown.length) throw new Error("Module không tồn tại: " + unknown.join(", "));
  const evidenceRefs = command.evidenceRefs ?? [];
  contextSources(data, conversation.id, evidenceRefs);
  const previous = currentDecisions(conversation).find(d => d.topic === topic);
  const decision: Decision = {
    id: randomUUID(), topic,
    decision: text(command.decision, "decision", 8000),
    rationale: text(command.rationale, "rationale", 4000),
    affects: [...command.affects], evidenceRefs: [...evidenceRefs],
    ...(previous ? { supersedes: previous.id } : {}),
    createdAt: now()
  };
  (conversation.decisions ??= []).push(decision);
  // Peers holding the replaced version only receive the new one on their next assignment.
  const stale = previous ? data.sessions.filter(s => s.conversationId === conversation.id &&
    s.role === "peer" && s.moduleId && command.affects.includes(s.moduleId) &&
    threadKnowledge(data, s).decisionIds.has(previous.id)).map(s => s.moduleId!) : [];
  return "Đã ghi quyết định " + topic + " (id=" + decision.id + ")" +
    (previous ? ", thay quyết định " + previous.id : "") +
    ". App đính kèm ở lần assign_module tiếp theo cho module: " + command.affects.join(", ") + "." +
    (stale.length ? " Peer đang giữ bản cũ: " + [...new Set(stale)].join(", ") + "." : "");
}
function deliver(data: Data, conversationId: string, sessionId: string, messageId: string,
  eventMessageIds?: string[]) {
  const entry: Delivery = {
    id: randomUUID(), conversationId, sessionId, messageId,
    ...(eventMessageIds ? { eventMessageIds } : {}),
    generation: data.conversations.find(c => c.id === conversationId)!.generation,
    status: "queued", createdAt: now(), updatedAt: now()
  };
  data.deliveries.push(entry);
  return entry;
}

/** Discovery is a prerequisite when Lead explicitly requests an overview. */
function pendingDiscovery(data: Data, conversation: Conversation): boolean {
  return data.deliveries.some(d => d.conversationId === conversation.id &&
    d.generation === conversation.generation &&
    (d.status === "queued" || d.status === "running") &&
    data.sessions.some(s => s.id === d.sessionId && s.role === "discovery"));
}

/** Queue only new events, never re-read recent App chat history into a Lead turn.
 * A queued batch coalesces events; a running batch remains immutable.
 */
function wakeLead(data: Data, conversation: Conversation, messageId: string): void {
  if (conversation.status !== "active") return;
  const pending = data.deliveries.find(d => d.conversationId === conversation.id &&
    d.sessionId === conversation.leadSessionId && d.status === "queued");
  if (pending) {
    const ids = pending.eventMessageIds!;
    if (!ids.includes(messageId)) ids.push(messageId);
    pending.updatedAt = now();
  } else {
    deliver(data, conversation.id, conversation.leadSessionId, messageId, [messageId]);
  }
}

function finishConversation(data: Data, conversation: Conversation): void {
  if (conversation.status === "finished") throw new Error("Task đã hoàn thành");
  conversation.status = "finished";
  // Invalidate events from Peer turns started before this finish, even after user reopens.
  conversation.generation += 1;
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
    this.db = new DatabaseSync(join(directory, "coordination.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL);");
    const row = this.db.prepare("SELECT body FROM snapshot WHERE id = 1").get() as { body: string } | undefined;
    this.state = row ? JSON.parse(row.body) as Data
      : { conversations: [], sessions: [], messages: [], deliveries: [], settings: emptySettings() };
    let changed = false;
    // Never replay Codex turns started before a crash.
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
        // Discovery is not replayed after a crash; notify Lead by an event.
        if (session?.role === "discovery") {
          const conversation = this.state.conversations.find(c => c.id === delivery.conversationId)!;
          if (conversation.status === "active" &&
              delivery.generation === conversation.generation) {
            const item = message(this.state, conversation.id, "system", "lead",
              "Discovery bị gián đoạn sau restart; Lead có thể giao lại khảo sát hoặc nhờ Peer điều tra.");
            wakeLead(this.state, conversation, item.id);
          }
        }
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
  /** Lead sees agent metadata only; its conversation messages are delivered via NEW_EVENTS. */
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
  /** Only the persisted incoming events for this Lead delivery. */
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
      wakeLead(data, conversation, item.id);
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
      // Batch the user event even during Discovery. startDelivery() enforces the phase barrier.
      wakeLead(data, conversation, item.id);
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
        item.generation !== conversation.generation) {
        throw new Error("Delivery thuộc task đã kết thúc");
      }
      // Also gate Lead deliveries already queued before Discovery was dispatched.
      if (session.role === "lead" && pendingDiscovery(data, conversation)) {
        throw new Error("Lead đang chờ Discovery; chưa được bắt đầu turn mới");
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
    allowedModuleIds: string[], discoveryEnabled = false): string {
    if (!callId.trim()) throw new Error("Missing Codex tool call ID");
    return this.mutate(data => {
      const active = data.deliveries.find(d => d.id === deliveryId);
      if (!active || active.status !== "running") throw new Error("Lead delivery is no longer active");
      const lead = data.sessions.find(s => s.id === active.sessionId);
      if (!lead || lead.role !== "lead") throw new Error("Only Lead may invoke routing tools");
      if (lead.handledToolCalls?.includes(callId)) return "Already executed (idempotent replay)";
      const conversation = data.conversations.find(c => c.id === active.conversationId)!;
      if (conversation.status !== "active") throw new Error("Task đã hoàn thành");
      const isDiscoveryCommand = command.type === "spawn_discovery" ||
        command.type === "send_discovery";
      // Synchronous SQLite transaction serializes even back-to-back app-server calls.
      // A Lead turn must never mix Discovery with implementation or finish().
      if (active.routingPhase === "discovery") {
        throw new Error("Đã giao Discovery trong turn này. Kết thúc Lead turn và chờ kết quả Discovery trước khi giao Peer hoặc finish.");
      }
      if (active.routingPhase === "execution" && isDiscoveryCommand) {
        throw new Error("Turn này đã giao Peer. Không thể đồng thời giao Discovery; kết thúc turn trước.");
      }
      if (pendingDiscovery(data, conversation)) {
        throw new Error("Discovery đang chạy hoặc chờ thực thi. Lead phải chờ báo cáo hoặc lỗi trước khi tiếp tục.");
      }
      let result: string;
      if (command.type === "update_task_brief") {
        checkTaskBrief(data, conversation, command.brief);
        conversation.taskBrief = structuredClone(command.brief);
        result = "Đã cập nhật Task Brief; Lead chịu trách nhiệm về các nhận định và bằng chứng.";
      } else if (command.type === "record_decision") {
        result = recordDecision(data, conversation, command, allowedModuleIds);
      } else if (command.type === "finish") {
        finishConversation(data, conversation);
        result = "Finished conversation " + conversation.id;
      } else if (command.type === "spawn_discovery" || command.type === "send_discovery") {
        if (!discoveryEnabled) throw new Error("Discovery chưa được cấu hình hoặc đang tắt");
        let discovery: AgentSession | undefined;
        if (command.type === "spawn_discovery") {
          if (data.sessions.some(s => s.conversationId === conversation.id && s.role === "discovery")) {
            throw new Error("Conversation đã có Discovery session; dùng send_discovery");
          }
          discovery = {
            id: randomUUID(), conversationId: conversation.id, role: "discovery",
            label: "Discovery", status: "idle", createdAt: now(), updatedAt: now()
          };
          data.sessions.push(discovery);
        } else {
          discovery = data.sessions.find(s => s.id === command.sessionId &&
            s.conversationId === conversation.id && s.role === "discovery");
          if (!discovery) throw new Error("Discovery session không tồn tại trong conversation: " + command.sessionId);
        }
        const packet = assignmentPacket(data, conversation, command, discovery);
        const outbound = message(data, conversation.id, "lead", "discovery",
          text(command.message, "Discovery message"), discovery.id, packet);
        deliver(data, conversation.id, discovery.id, outbound.id);
        result = "Đã giao khám phá sơ bộ cho Discovery (sessionId=" + discovery.id +
          ")." + omissionNote(packet) +
          " Kết thúc Lead turn ngay, không giao Peer hoặc finish trong turn này. Chờ kết quả/lỗi Discovery tự đánh thức Lead.";
        active.routingPhase = "discovery";
      } else {
        if (!allowedModuleIds.includes(command.moduleId)) {
          throw new Error("Module không tồn tại: " + command.moduleId);
        }
        // One owner per module: reuse its Thread; the newest wins for legacy data.
        let peer = data.sessions.filter(s => s.conversationId === conversation.id &&
          s.role === "peer" && s.moduleId === command.moduleId).at(-1);
        const created = !peer;
        if (!peer) {
          peer = {
            id: randomUUID(), conversationId: conversation.id, role: "peer",
            moduleId: command.moduleId, label: "Peer " + command.moduleId, status: "idle",
            ...normalizeSelection({
              model: command.model ?? data.settings.peer.model,
              effort: command.effort ?? data.settings.peer.effort
            }),
            createdAt: now(), updatedAt: now()
          };
          data.sessions.push(peer);
        }
        const packet = assignmentPacket(data, conversation, command, peer);
        const outbound = message(data, conversation.id, "lead", "peer",
          text(command.message, "Peer message"), peer.id, packet);
        deliver(data, conversation.id, peer.id, outbound.id);
        result = "Đã giao việc tới " + peer.label + " (sessionId=" + peer.id + ", " +
          (created ? "Peer mới" : "dùng lại Thread của Peer module") + ")." +
          (!created && (command.model || command.effort)
            ? " model/effort chỉ áp dụng khi tạo Peer; Peer này giữ lựa chọn cũ." : "") +
          omissionNote(packet) + " Kết quả sẽ tự gửi lại Lead.";
        active.routingPhase = "execution";
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
      if (s.role === "lead") {
        const running = data.deliveries.find(d => d.sessionId === sessionId &&
          d.status === "running");
        if (running) running.codexTurnId = turnId;
      }
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
  /** Discovery reports preliminary context; Lead decides whether deeper investigation is needed. */
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
          delivery.generation === conversation.generation) {
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
        delivery.generation === conversation.generation) {
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
        delivery.generation === conversation.generation) {
        message(data, conversation.id, "system", "user", body);
        if (session.role === "peer" || session.role === "discovery") {
          const item = message(data, conversation.id, "system", "lead",
            session.role === "discovery"
              ? body + ". Lead có thể giao lại Discovery hoặc nhờ Peer khảo sát."
              : body, session.id);
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
