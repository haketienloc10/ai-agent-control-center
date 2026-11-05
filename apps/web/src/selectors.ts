import type { AgentSession, Conversation, Delivery, Message, Snapshot } from "@aacc/contracts";

export type Tone = "success" | "info" | "warning" | "error" | "neutral";
export interface StatusLabel { label: string; tone: Tone; }

export function conversationStatus(data: Snapshot, conversation: Conversation): StatusLabel {
  if (conversation.status === "finished") return { label: "Đã kết thúc", tone: "success" };
  const sessions = data.sessions.filter(s => s.conversationId === conversation.id);
  const lead = sessions.find(s => s.id === conversation.leadSessionId);
  if (lead?.status === "interrupted") return { label: "Lead gặp lỗi", tone: "error" };
  if (sessions.some(s => s.role === "peer" && s.status === "interrupted")) {
    return { label: "Peer gặp lỗi", tone: "error" };
  }
  if (lead?.status === "running") return { label: "Lead đang xử lý", tone: "info" };
  if (sessions.some(s => s.role === "peer" && s.status === "running")) {
    return { label: "Đang chờ Peer", tone: "info" };
  }
  if (data.deliveries.some(d => d.conversationId === conversation.id && d.status === "queued")) {
    return { label: "Đang xếp hàng", tone: "warning" };
  }
  return { label: "Chờ sự kiện", tone: "neutral" };
}

export function sessionStatus(session: AgentSession): StatusLabel {
  if (session.status === "running") return { label: "Đang chạy", tone: "info" };
  if (session.status === "interrupted") return { label: "Bị gián đoạn", tone: "error" };
  return { label: "Idle", tone: "neutral" };
}

export function latestDelivery(data: Snapshot, sessionId: string): Delivery | undefined {
  return [...data.deliveries].reverse().find(d => d.sessionId === sessionId);
}

export interface Activity {
  id: string;
  at: string;
  label: string;
  tone: Tone;
}

/** Only persisted messages are shown. No invented finish/progress events. */
export function recentActivity(data: Snapshot, conversationId: string, count = 5): Activity[] {
  const labels = new Map(data.sessions.filter(s => s.conversationId === conversationId)
    .map(s => [s.id, s.label]));
  return data.messages
    .filter(m => m.conversationId === conversationId)
    .map((m: Message): Activity => {
      if (m.from === "lead" && m.to === "peer") {
        return { id: m.id, at: m.createdAt,
          label: "Lead giao việc cho " + (labels.get(m.peerSessionId ?? "") ?? "Peer"), tone: "info" };
      }
      if (m.from === "peer") {
        return { id: m.id, at: m.createdAt,
          label: (labels.get(m.peerSessionId ?? "") ?? "Peer") + " gửi kết quả", tone: "success" };
      }
      if (m.from === "user") {
        return { id: m.id, at: m.createdAt, label: "Bạn gửi yêu cầu cho Lead", tone: "neutral" };
      }
      if (m.from === "system") {
        return { id: m.id, at: m.createdAt, label: "Hệ thống thông báo", tone: "error" };
      }
      return { id: m.id, at: m.createdAt, label: "Lead phản hồi cho bạn", tone: "neutral" };
    })
    .reverse().slice(0, count);
}

export const shortTime = (value: string) => new Date(value).toLocaleTimeString("vi-VN", {
  hour: "2-digit", minute: "2-digit"
});
export const shortDate = (value: string) => new Date(value).toLocaleDateString("vi-VN", {
  day: "2-digit", month: "2-digit", year: "numeric"
});
