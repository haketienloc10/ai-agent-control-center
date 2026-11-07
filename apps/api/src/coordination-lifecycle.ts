import { randomUUID } from "node:crypto";
import type { Conversation, Delivery, Message } from "@aacc/contracts";
import { deliver, message, now, text, type Data } from "./coordination-state.js";

export function pendingDiscovery(data: Data, conversation: Conversation): boolean {
  return data.deliveries.some(d => d.conversationId === conversation.id &&
    d.generation === conversation.generation &&
    (d.status === "queued" || d.status === "running") &&
    data.sessions.some(s => s.id === d.sessionId && s.role === "discovery"));
}

/** Chỉ queue event mới vào Lead turn, không đọc lại lịch sử chat của App.
 * Batch queued gộp event; batch running giữ nguyên.
 */
export function wakeLead(data: Data, conversation: Conversation, messageId: string): void {
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

export function finishConversation(data: Data, conversation: Conversation): void {
  if (conversation.status === "finished") throw new Error("Task đã hoàn thành");
  conversation.status = "finished";
  // Vô hiệu event từ Peer turn trước finish, kể cả khi user mở lại task.
  conversation.generation += 1;
  conversation.updatedAt = now();
  // Không chạy việc chưa bắt đầu sau finish. Peer đang chạy vẫn có thể báo cáo,
  // nhưng báo cáo chỉ được lưu, không đánh thức Lead.
  for (const pending of data.deliveries) {
    if (pending.conversationId === conversation.id && pending.status === "queued") {
      pending.status = "superseded";
      pending.updatedAt = now();
    }
  }
}

/** Đánh dấu turn đang chạy là interrupted; không replay sau restart. */
export function recoverRunningDeliveries(data: Data): boolean {
  let changed = false;
  // Không replay Codex turn đã bắt đầu trước khi crash.
  for (const delivery of data.deliveries) {
    if (delivery.status === "running") {
      delivery.status = "interrupted";
      delivery.error = "Backend restarted during Codex turn; not replayed";
      delivery.updatedAt = now();
      const session = data.sessions.find(s => s.id === delivery.sessionId);
      if (session) {
        session.status = "interrupted"; session.error = delivery.error; session.updatedAt = now();
      }
      message(data, delivery.conversationId, "system", "user",
        "Phiên " + (session?.label ?? delivery.sessionId) +
        " bị gián đoạn khi Backend khởi động lại. Không tự chạy lại prompt trước.");
      // Không replay Discovery sau crash; thông báo cho Lead bằng event.
      if (session?.role === "discovery") {
        const conversation = data.conversations.find(c => c.id === delivery.conversationId)!;
        if (conversation.status === "active" &&
            delivery.generation === conversation.generation) {
          const item = message(data, conversation.id, "system", "lead",
            "Discovery bị gián đoạn sau restart; Lead có thể giao lại khảo sát hoặc nhờ Peer điều tra.");
          wakeLead(data, conversation, item.id);
        }
      }
      changed = true;
    }
  }
  return changed;
}

export function recordHandoffPrompt(data: Data, deliveryId: string, prompt: string): string {
  const delivery = data.deliveries.find(d => d.id === deliveryId);
  const input = data.messages.find(m => m.id === delivery?.messageId);
  if (!delivery || delivery.status !== "running" || !input ||
      input.from !== "lead" || (input.to !== "peer" && input.to !== "discovery")) {
    throw new Error("Không thể lưu nội dung chuyển giao ngoài lượt worker đang chạy");
  }
  input.handoffPrompt ??= prompt;
  return input.handoffPrompt;
}

export function createConversation(data: Data, request: string, title?: string): Conversation {
  const value = text(request, "Yêu cầu");
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
}

export function postUser(data: Data, conversationId: string, body: string): Message {
  const value = text(body, "Tin nhắn");
  const conversation = data.conversations.find(c => c.id === conversationId);
  if (!conversation) throw new Error("Conversation not found");
  conversation.status = "active"; conversation.updatedAt = now();
  const item = message(data, conversationId, "user", "lead", value);
  // Gộp event của user cả khi Discovery đang chạy; startDelivery() kiểm tra phase.
  wakeLead(data, conversation, item.id);
  return item;
}

export function startDelivery(data: Data, id: string): Delivery {
  const item = data.deliveries.find(d => d.id === id);
  if (!item || item.status !== "queued") throw new Error("Delivery not queued");
  const session = data.sessions.find(s => s.id === item.sessionId);
  if (!session || session.status === "running") throw new Error("Session is unavailable");
  const conversation = data.conversations.find(c => c.id === item.conversationId);
  if (!conversation || conversation.status !== "active" ||
    item.generation !== conversation.generation) {
    throw new Error("Delivery thuộc task đã kết thúc");
  }
  // Chặn cả Lead delivery đã queue trước khi giao Discovery.
  if (session.role === "lead" && pendingDiscovery(data, conversation)) {
    throw new Error("Lead đang chờ Discovery; chưa được bắt đầu turn mới");
  }
  item.status = "running"; item.updatedAt = now();
  session.status = "running"; session.error = undefined; session.updatedAt = now();
  return item;
}

export function setThread(data: Data, sessionId: string, threadId: string): void {
  const s = data.sessions.find(s => s.id === sessionId);
  if (!s) throw new Error("Session not found");
  s.threadId = threadId; s.updatedAt = now();
}

export function setTurn(data: Data, sessionId: string, turnId: string): void {
  const s = data.sessions.find(s => s.id === sessionId);
  if (!s) throw new Error("Session not found");
  s.turnId = turnId; s.updatedAt = now();
  if (s.role === "lead") {
    const running = data.deliveries.find(d => d.sessionId === sessionId &&
      d.status === "running");
    if (running) running.codexTurnId = turnId;
  }
}

export function completeLead(data: Data, id: string, reply: string, finished = false): void {
  const delivery = data.deliveries.find(d => d.id === id);
  if (!delivery || delivery.status !== "running") throw new Error("Lead delivery not running");
  const lead = data.sessions.find(s => s.id === delivery.sessionId)!;
  const conversation = data.conversations.find(c => c.id === delivery.conversationId)!;
  if (lead.role !== "lead") throw new Error("Only Lead may send Lead replies");
  delivery.status = "completed"; delivery.updatedAt = now();
  lead.status = "idle"; lead.updatedAt = now();
  // Turn finished giữ Codex finalText; dùng thông báo mặc định nếu finalText rỗng.
  // Turn khác không được gửi phản hồi sau khi task đã finished.
  if (finished || conversation.status === "active") {
    const body = reply.trim() ? reply : (finished ? "Task đã hoàn thành." : "");
    if (body) message(data, conversation.id, "lead", "user", body);
  }
  conversation.updatedAt = now();
}

export function completeDiscovery(data: Data, id: string, result: string): void {
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
}

export function completePeer(data: Data, id: string, result: string): void {
  const delivery = data.deliveries.find(d => d.id === id);
  if (!delivery || delivery.status !== "running") throw new Error("Peer delivery not running");
  const session = data.sessions.find(s => s.id === delivery.sessionId)!;
  const conversation = data.conversations.find(c => c.id === delivery.conversationId)!;
  delivery.status = "completed"; delivery.updatedAt = now();
  session.status = "idle"; session.updatedAt = now();
  const item = message(data, conversation.id, "peer", "lead",
    result.trim() || "(Peer không trả về nội dung)", session.id);
  // Chỉ chuyển Peer tới Lead; không có đường chuyển Peer tới Peer.
  if (conversation.status === "active" &&
    delivery.generation === conversation.generation) {
    wakeLead(data, conversation, item.id);
  }
  conversation.updatedAt = now();
}

export function failDelivery(data: Data, id: string, cause: string): void {
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
    // Tool finish thành công nhưng Codex turn gặp lỗi trước khi có finalText.
    message(data, conversation.id, "system", "user",
      "Task đã được đánh dấu hoàn thành nhưng Codex không tạo được báo cáo cuối. " + body);
  }
}
