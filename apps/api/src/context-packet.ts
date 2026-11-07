import type { AgentSession, ContextPacket, ContextSource, Conversation, Decision, LeadCommand, MessageAuthor } from "@aacc/contracts";
import { text, type Data } from "./coordination-state.js";

const sourceKind = (from: MessageAuthor): ContextSource["kind"] =>
  from === "discovery" ? "discovery-preliminary" : from === "peer" ? "peer-report" :
  from === "user" ? "user-request" : from === "lead" ? "lead-note" : "system-event";
/** Chọn bằng chứng trong cùng conversation trước khi queue.
 * Ref trong `skip` vẫn được kiểm tra nhưng không sao chép lại. */
export function contextSources(data: Data, conversationId: string, refs: string[] = [],
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
    sources.push({ messageId: item.id, from: item.from, kind: sourceKind(item.from), text: item.text,
      createdAt: item.createdAt });
  }
  return sources;
}

/** Kiến thức đã có trong Thread của worker, chỉ tính turn completed.
 * Handoff bị gián đoạn có thể chưa tới Thread nên phải gửi lại đầy đủ. */
export function threadKnowledge(data: Data, session: AgentSession) {
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
  // Báo cáo của worker được tạo ngay trong Thread này.
  for (const m of data.messages) {
    if (m.from === session.role && (m.peerSessionId === session.id ||
      m.discoverySessionId === session.id)) messageIds.add(m.id);
  }
  return { messageIds, decisionIds, hasRequest, brief };
}

/** Quyết định hiện tại theo topic: bản ghi mới nhất có hiệu lực. */
export function currentDecisions(conversation: Conversation): Decision[] {
  const byTopic = new Map<string, Decision>();
  for (const decision of conversation.decisions ?? []) byTopic.set(decision.topic, decision);
  return [...byTopic.values()];
}

/** Peer luôn nhận checkpoint; Discovery và nguồn dài tiếp tục dùng delta. */
export function assignmentPacket(data: Data, conversation: Conversation,
  command: Extract<LeadCommand, { message: string }>, target: AgentSession,
  assignmentId?: string): ContextPacket {
  const original = data.messages.find(m => m.conversationId === conversation.id &&
    m.from === "user");
  if (!original) throw new Error("Conversation không có yêu cầu gốc");
  const expectedResult = text(command.expectedResult, "expectedResult", 4000);
  const known = threadKnowledge(data, target);
  // App đính kèm yêu cầu gốc riêng, không lặp lại trong sources.
  const skip = new Set([...known.messageIds, original.id]);
  const refs = command.contextRefs ?? [];
  const skippedIds = refs.filter(ref => skip.has(ref));
  const brief = conversation.taskBrief;
  const sources = contextSources(data, conversation.id, refs, skip);
  if (command.type === "assign_module") {
    const constraints = command.constraints ?? [];
    if (!Array.isArray(constraints) || constraints.length > 20) {
      throw new Error("constraints phải là mảng tối đa 20 phần tử");
    }
    const checkedConstraints = constraints.map(item => text(item, "constraint", 2000));
    const notes = command.previousContext ?? [];
    if (!Array.isArray(notes) || notes.length > 8 ||
      new Set(notes.map(note => note?.messageId)).size !== notes.length) {
      throw new Error("previousContext cần tối đa 8 nguồn không trùng");
    }
    for (const note of notes) {
      if (!note || !refs.includes(note.messageId) || !known.messageIds.has(note.messageId)) {
        throw new Error("previousContext phải chọn nguồn trong contextRefs đã có trong Thread");
      }
      text(note.summary, "previousContext summary", 2000);
    }
    const summaries = new Map(notes.map(note => [note.messageId, note.summary.trim()]));
    const previous = data.messages.filter(m => m.from === "lead" && m.peerSessionId === target.id).at(-1);
    const decisions = currentDecisions(conversation).filter(d => d.affects.includes(command.moduleId));
    const previousContext = skippedIds.filter(id => known.messageIds.has(id)).map(id => {
      const item = data.messages.find(m => m.id === id)!;
      return {
        messageId: item.id, from: item.from, kind: sourceKind(item.from),
        createdAt: item.createdAt,
        ...(summaries.has(id) ? { summary: summaries.get(id)! } : {})
      };
    });
    if (!assignmentId) throw new Error("Peer assignment thiếu ID");
    return {
      peerCheckpoint: {
        assignmentId, moduleId: command.moduleId,
        ...(previous ? { continues: previous.id } : {}),
        goal: brief?.goal ?? original.text,
        acceptanceCriteria: structuredClone(brief?.acceptanceCriteria ?? []),
        constraints: checkedConstraints
      },
      ...(known.hasRequest ? {} : { originalRequest: { messageId: original.id, text: original.text } }),
      sources, previousContext, decisions: structuredClone(decisions), expectedResult,
      ...(skippedIds.length ? { omitted: { sourceIds: skippedIds } } : {})
    };
  }
  const briefUnchanged = Boolean(brief) && known.brief === JSON.stringify(brief);
  return {
    ...(known.hasRequest ? {} : { originalRequest: { messageId: original.id, text: original.text } }),
    ...(brief && !briefUnchanged ? { taskBrief: structuredClone(brief) } : {}),
    sources,
    expectedResult,
    ...(briefUnchanged || skippedIds.length ? { omitted: {
      ...(briefUnchanged ? { taskBrief: true as const } : {}),
      ...(skippedIds.length ? { sourceIds: skippedIds } : {})
    } } : {})
  };
}
/** Thông báo nguồn App đã lược bỏ để Lead tránh lặp lại ở tin nhắn tiếp theo. */
export function omissionNote(packet: ContextPacket): string {
  const ids = packet.omitted?.sourceIds;
  return ids?.length ? " Không gửi lại " + ids.length + " nguồn đã có trong context của worker: " +
    ids.join(", ") + "." : "";
}
