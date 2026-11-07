import type { ContextPacket, Message } from "@aacc/contracts";

/** Each Worker receives only this handoff delta, never a shared Lead/other-agent Thread. */
function packetParts(packet: ContextPacket): string[] {
  const inThread = "(đã gửi ở lượt trước trong Thread này; dùng nội dung đó)";
  return [
    "ORIGINAL_USER_REQUEST: " + (packet.originalRequest ? JSON.stringify(packet.originalRequest) : inThread),
    "TASK_BRIEF_FROM_LEAD: " + (packet.taskBrief ? JSON.stringify(packet.taskBrief)
      : packet.omitted?.taskBrief ? "(không đổi so với lượt trước trong Thread này)" : "null"),
    "SUPPORTING_CONTEXT: " + JSON.stringify(packet.sources),
    ...(packet.omitted?.sourceIds?.length
      ? ["SOURCES_ALREADY_IN_THREAD: " + JSON.stringify(packet.omitted.sourceIds)] : []),
    ...(packet.decisions?.length
      ? ["DECISIONS_FROM_LEAD: " + JSON.stringify(packet.decisions)] : []),
    ...(packet.omitted?.decisionIds?.length
      ? ["DECISIONS_ALREADY_IN_THREAD: " + JSON.stringify(packet.omitted.decisionIds)] : []),
    "LEAD_EXPECTED_RESULT: " + packet.expectedResult
  ];
}
function workerPacket(message: Message): ContextPacket {
  if (!message.contextPacket) throw new Error("Worker delivery thiếu Context Packet");
  return message.contextPacket;
}
function discoveryPrompt(message: Message): string {
  return [...packetParts(workerPacket(message)), "LEAD_MESSAGE: " + message.text].join("\n\n");
}
function peerPrompt(message: Message): string {
  const packet = workerPacket(message);
  const checkpoint = packet.peerCheckpoint;
  // Giữ nguyên packet cũ đã queued; không tái tạo context bằng trạng thái mới hơn.
  if (!checkpoint) return [...packetParts(packet), "LEAD_MESSAGE: " + message.text].join("\n\n");
  const list = (items: string[], empty: string) => items.length
    ? items.map(item => "- " + item.replaceAll("\n", "\n  ")).join("\n") : empty;
  return [
    "ASSIGNMENT: " + checkpoint.assignmentId,
    "MODULE: " + checkpoint.moduleId,
    ...(checkpoint.continues ? ["CONTINUES: " + checkpoint.continues] : []),
    ...(packet.originalRequest ? ["ORIGINAL_USER_REQUEST:\n" + packet.originalRequest.text] : []),
    "CURRENT_GOAL:\n" + checkpoint.goal,
    "ACCEPTANCE_CRITERIA:\n" + list(checkpoint.acceptanceCriteria, "Lead chưa cung cấp tiêu chí hoàn thành."),
    "CURRENT_CONSTRAINTS:\n" + list(checkpoint.constraints, "Không có ràng buộc bổ sung do Lead cung cấp."),
    "ACTIVE_DECISIONS:\n" + list((packet.decisions ?? []).map(d =>
      d.id + " · " + d.topic + "\n" + d.decision +
      (d.evidenceRefs.length ? "\nCăn cứ: " + d.evidenceRefs.join(", ") : "")),
      "Không có quyết định áp dụng cho module trong assignment này."),
    "PREVIOUS_CONTEXT:\n" + list((packet.previousContext ?? []).map(source =>
      source.messageId + " · " + source.kind + " · " + source.from + " · " + source.createdAt +
      "\n" + (source.summary ?? "Nội dung đã có trong Thread; Lead không cung cấp tóm tắt.")), "Không có nguồn cũ được chọn."),
    "NEW_SUPPORTING_CONTEXT:\n" + (packet.sources.length ? packet.sources.map(source =>
      source.messageId + " · " + source.kind + " · " + source.from + " · " + source.createdAt + "\n" + source.text
    ).join("\n\n") : "Không có nguồn mới."),
    "WORK:\n" + message.text,
    "EXPECTED_RESULT:\n" + packet.expectedResult
  ].join("\n\n");
}

/** Cùng chuỗi được lưu vào trace và truyền tới runtime. */
export function workerPrompt(message: Message): string {
  if (message.to === "peer") return peerPrompt(message);
  if (message.to === "discovery") return discoveryPrompt(message);
  throw new Error("Worker prompt cần message gửi tới agent");
}
