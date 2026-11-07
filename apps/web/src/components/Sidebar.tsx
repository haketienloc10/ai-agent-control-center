import type { Conversation, Snapshot } from "@aacc/contracts";
import { conversationStatus, shortDate } from "../selectors.js";

export type ConnectionState = "connecting" | "connected" | "offline";

export function Sidebar({ data, conversations, activeId, connection, onSelect, onNew, onSettings }: {
  data: Snapshot;
  conversations: Conversation[];
  activeId: string;
  connection: ConnectionState;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSettings: () => void;
}) {
  return <aside className="sidebar">
    <div className="brand">
      <span className="brand-icon" aria-hidden="true">AC</span>
      <span className="brand-copy"><strong>Agent Control Center</strong>
        <small>LEAD · PEER · LOCAL</small></span>
    </div>
    <div className="sidebar-actions">
      <button type="button" className="primary full" onClick={onNew} title="Yêu cầu mới cho Lead">
        <span aria-hidden="true">＋</span> <span className="sidebar-action-label">Yêu cầu mới cho Lead</span>
      </button>
      <button type="button" className="settings-open full" onClick={onSettings} title="App Settings">
        <span aria-hidden="true">⚙</span> <span className="sidebar-action-label">App Settings</span>
      </button>
    </div>
    <div className="side-heading">Các cuộc việc <span>{conversations.length}</span></div>
    <nav className="conversation-list" aria-label="Các cuộc việc">
      {conversations.map(conversation => {
        const status = conversationStatus(data, conversation);
        return <button key={conversation.id} type="button"
          className={"conversation-link " + (conversation.id === activeId ? "chosen" : "")}
          title={conversation.title + " · " + status.label}
          aria-current={conversation.id === activeId ? "page" : undefined}
          onClick={() => onSelect(conversation.id)}>
          <span className="conversation-icon" aria-hidden="true">▤</span>
          <span className="conversation-meta">
            <strong title={conversation.title}>{conversation.title}</strong>
            <small>{shortDate(conversation.updatedAt)}</small>
            <span className={"status-chip " + status.tone}>{status.label}</span>
          </span>
        </button>;
      })}
      {!conversations.length && <p className="hint no-conversations">
        Chưa có cuộc việc. Tạo yêu cầu đầu tiên để bắt đầu.
      </p>}
    </nav>
    <div className="sidebar-footer">
      <div className="connection-line" title={connection === "connected" ? "Backend đã kết nối" :
        connection === "connecting" ? "Đang kết nối Backend" : "Mất kết nối Backend"}>
        <span className={"connection-dot " + connection} aria-hidden="true"/>
        <span>{connection === "connected" ? "Backend đã kết nối" :
          connection === "connecting" ? "Đang kết nối Backend" : "Mất kết nối Backend"}</span>
      </div>
      <small>Localhost · SSE {connection === "connected" ? "đang hoạt động" : "chưa kết nối"}</small>
    </div>
  </aside>;
}
