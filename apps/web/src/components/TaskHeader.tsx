import type { Conversation, Snapshot } from "@aacc/contracts";
import { conversationStatus, sessionStatus } from "../selectors.js";

export function TaskHeader({ data, conversation }: {
  data: Snapshot;
  conversation: Conversation;
}) {
  const sessions = data.sessions.filter(s => s.conversationId === conversation.id);
  const lead = sessions.find(s => s.id === conversation.leadSessionId);
  const runningPeers = sessions.filter(s => s.role === "peer" && s.status === "running").length;
  const queued = data.deliveries.filter(d =>
    d.conversationId === conversation.id && d.status === "queued").length;
  const status = conversationStatus(data, conversation);
  const request = data.messages.find(m =>
    m.conversationId === conversation.id && m.from === "user");
  const description = request?.text.replace(/\s+/g, " ").trim();
  return <div className="workspace-heading">
    <div className="topbar">
      <div className="task-heading">
        <span className="eyebrow">WORKSPACE / LEAD</span>
        <h1>{conversation.title}</h1>
        <p title={description}>{description || "Theo dõi điều phối và trao đổi với Lead."}</p>
      </div>
      <span className={"status-chip task-status " + status.tone}>{status.label}</span>
    </div>
    <div className="summary-bar" aria-label="Tổng quan task">
      <div className="metric">
        <span className="metric-icon" aria-hidden="true">L</span>
        <span className="metric-info"><small>Lead Agent</small>
          <strong>{lead ? sessionStatus(lead).label : "Chưa khởi tạo"}</strong></span>
      </div>
      <div className="metric">
        <span className="metric-icon" aria-hidden="true">◎</span>
        <span className="metric-info"><small>Peer đang chạy</small>
          <strong className="metric-number">{runningPeers}</strong></span>
      </div>
      <div className="metric">
        <span className="metric-icon" aria-hidden="true">☷</span>
        <span className="metric-info"><small>Delivery chờ</small>
          <strong className="metric-number">{queued}</strong></span>
      </div>
      <div className="metric">
        <span className="metric-icon" aria-hidden="true">✓</span>
        <span className="metric-info"><small>Trạng thái task</small>
          <strong>{conversation.status === "finished" ? "Finished" : "Active"}</strong></span>
      </div>
    </div>
  </div>;
}
