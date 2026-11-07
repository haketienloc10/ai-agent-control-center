import { randomUUID } from "node:crypto";
import type { AgentSession, Conversation, Decision, Delivery, LeadCommand, TaskBrief } from "@aacc/contracts";
import { assignmentPacket, contextSources, currentDecisions, omissionNote, threadKnowledge } from "./context-packet.js";
import { finishConversation, pendingDiscovery } from "./coordination-lifecycle.js";
import { normalizeSelection } from "./coordination-settings.js";
import { deliver, message, now, text, type Data } from "./coordination-state.js";

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
/** Thêm vào Decision Log. App chỉ lưu và chuyển tiếp, không đánh giá quyết định. */
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
  // Peer đang giữ bản cũ nhận bản mới ở lần giao việc tiếp theo.
  const stale = previous ? data.sessions.filter(s => s.conversationId === conversation.id &&
    s.role === "peer" && s.moduleId && command.affects.includes(s.moduleId) &&
    threadKnowledge(data, s).decisionIds.has(previous.id)).map(s => s.moduleId!) : [];
  return "Đã ghi quyết định " + topic + " (id=" + decision.id + ")" +
    (previous ? ", thay quyết định " + previous.id : "") +
    ". App đính kèm ở lần assign_module tiếp theo cho module: " + command.affects.join(", ") + "." +
    (stale.length ? " Peer đang giữ bản cũ: " + [...new Set(stale)].join(", ") + "." : "");
}

function dispatchDiscovery(data: Data, conversation: Conversation, active: Delivery,
  command: Extract<LeadCommand, { type: "spawn_discovery" | "send_discovery" }>, discoveryEnabled: boolean): string {
  let result: string;
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
  return result;
}

function assignModule(data: Data, conversation: Conversation, active: Delivery,
  command: Extract<LeadCommand, { type: "assign_module" }>, allowedModuleIds: string[]): string {
  let result: string;
  if (!allowedModuleIds.includes(command.moduleId)) {
    throw new Error("Module không tồn tại: " + command.moduleId);
  }
  // Mỗi module có một Peer: dùng lại Thread; dữ liệu cũ chọn session mới nhất.
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
  const assignmentId = randomUUID();
  const packet = assignmentPacket(data, conversation, command, peer, assignmentId);
  const outbound = message(data, conversation.id, "lead", "peer",
    text(command.message, "Peer message"), peer.id, packet, assignmentId);
  deliver(data, conversation.id, peer.id, outbound.id);
  result = "Đã giao việc tới " + peer.label + " (sessionId=" + peer.id + ", " +
    (created ? "Peer mới" : "dùng lại Thread của Peer module") + ")." +
    (!created && (command.model || command.effort)
      ? " model/effort chỉ áp dụng khi tạo Peer; Peer này giữ lựa chọn cũ." : "") +
    omissionNote(packet) + " Kết quả sẽ tự gửi lại Lead.";
  active.routingPhase = "execution";
  return result;
}

function applyLeadCommand(data: Data, conversation: Conversation, active: Delivery,
  command: LeadCommand, allowedModuleIds: string[], discoveryEnabled: boolean): string {
  switch (command.type) {
    case "update_task_brief":
      checkTaskBrief(data, conversation, command.brief);
      conversation.taskBrief = structuredClone(command.brief);
      return "Đã cập nhật Task Brief; Lead chịu trách nhiệm về các nhận định và bằng chứng.";
    case "record_decision":
      return recordDecision(data, conversation, command, allowedModuleIds);
    case "finish":
      finishConversation(data, conversation);
      return "Finished conversation " + conversation.id;
    case "spawn_discovery":
    case "send_discovery":
      return dispatchDiscovery(data, conversation, active, command, discoveryEnabled);
    case "assign_module":
      return assignModule(data, conversation, active, command, allowedModuleIds);
  }
}

/** Cùng một candidate chứa mutation và callId; caller commit toàn bộ một lần. */
export function handleLeadCommand(data: Data, deliveryId: string, callId: string, command: LeadCommand,
  allowedModuleIds: string[], discoveryEnabled: boolean): string {
  const active = data.deliveries.find(d => d.id === deliveryId);
  if (!active || active.status !== "running") throw new Error("Lead delivery is no longer active");
  const lead = data.sessions.find(s => s.id === active.sessionId);
  if (!lead || lead.role !== "lead") throw new Error("Only Lead may invoke routing tools");
  if (lead.handledToolCalls?.includes(callId)) return "Already executed (idempotent replay)";
  const conversation = data.conversations.find(c => c.id === active.conversationId)!;
  if (conversation.status !== "active") throw new Error("Task đã hoàn thành");
  const isDiscoveryCommand = command.type === "spawn_discovery" ||
    command.type === "send_discovery";
  // Mutation đồng bộ được commit cùng callId trong một snapshot SQLite.
  // Một Lead turn không được vừa giao Discovery vừa giao Peer hoặc finish().
  if (active.routingPhase === "discovery") {
    throw new Error("Đã giao Discovery trong turn này. Kết thúc Lead turn và chờ kết quả Discovery trước khi giao Peer hoặc finish.");
  }
  if (active.routingPhase === "execution" && isDiscoveryCommand) {
    throw new Error("Turn này đã giao Peer. Không thể đồng thời giao Discovery; kết thúc turn trước.");
  }
  if (pendingDiscovery(data, conversation)) {
    throw new Error("Discovery đang chạy hoặc chờ thực thi. Lead phải chờ báo cáo hoặc lỗi trước khi tiếp tục.");
  }
  const result = applyLeadCommand(data, conversation, active, command, allowedModuleIds, discoveryEnabled);
  lead.handledToolCalls ??= [];
  lead.handledToolCalls.push(callId);
  // Giới hạn cache replay; các bản ghi chỉ là ID chống trùng ở tầng transport.
  if (lead.handledToolCalls.length > 4096) lead.handledToolCalls.splice(0, 2048);
  conversation.updatedAt = now();
  return result;
}
