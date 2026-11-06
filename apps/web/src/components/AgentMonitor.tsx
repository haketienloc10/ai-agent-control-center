import type { AgentSession, Conversation, Message, Snapshot } from "@aacc/contracts";
import { peerMessages } from "../message-view.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { latestDelivery, recentActivity, sessionStatus, shortTime } from "../selectors.js";

function lastTurnText(session: AgentSession, data: Snapshot): string {
  const delivery = latestDelivery(data, session.id);
  if (!delivery) return "Chưa có lượt xử lý";
  switch (delivery.status) {
    case "completed": return "Lượt gần nhất đã hoàn thành";
    case "running": return "Đang thực hiện lượt xử lý";
    case "queued": return "Lượt tiếp theo đang chờ";
    case "interrupted": return "Lượt gần nhất bị gián đoạn";
    case "superseded": return "Lượt chờ đã được bỏ qua";
  }
}

function PeerTranscript({ peer, messages }: { peer: AgentSession; messages: Message[] }) {
  const transcript = peerMessages(messages, peer.id);
  return <div className="peer-transcript" id={"transcript-" + peer.id}>
    <div className="transcript-title">Trao đổi gần đây với {peer.label}</div>
    {transcript.slice(-8).map(message => <div key={message.id} className="transcript-message">
      <strong>{message.from === "lead" ? "Lead giao việc" : "Peer phản hồi"}
        <time dateTime={message.createdAt}>{shortTime(message.createdAt)}</time></strong>
      <div className="peer-message-content"><MarkdownContent content={message.text}/></div>
    </div>)}
    {!transcript.length && <p>Chưa có trao đổi với Peer này.</p>}
    {peer.error && <p className="peer-error" role="alert">{peer.error}</p>}
  </div>;
}

export function AgentMonitor({ data, conversation, selectedPeerId, onSelectPeer }: {
  data: Snapshot;
  conversation: Conversation;
  selectedPeerId: string;
  onSelectPeer: (id: string) => void;
}) {
  const sessions = data.sessions.filter(s => s.conversationId === conversation.id);
  const lead = sessions.find(s => s.id === conversation.leadSessionId);
  const peers = sessions.filter(s => s.role === "peer");
  const discovery = sessions.find(s => s.role === "discovery");
  const events = recentActivity(data, conversation.id, 5);
  const conversationMessages = data.messages.filter(m => m.conversationId === conversation.id);
  const leadState = lead ? sessionStatus(lead) : { label: "Chưa khởi tạo", tone: "neutral" };
  return <aside className="agents-panel" aria-label="Theo dõi hoạt động">
    <div className="section-header monitor-heading">
      <div><h2>Theo dõi hoạt động</h2>
        <p>Trạng thái thực của các agent và thông tin gần đây.</p></div>
    </div>
    <div className="monitor-section">
      <div className="lead-card">
        <span className="avatar lead-avatar" aria-hidden="true">L</span>
        <div className="agent-info">
          <div className="agent-title"><strong>Lead Agent</strong>
            <span className={"status-chip " + leadState.tone}>{leadState.label}</span></div>
          <small>Workspace chung</small>
          <small>Model yêu cầu: {data.settings.lead.model || "Mặc định Codex"}</small>
          <small>Effort: {data.settings.lead.effort || "Mặc định Codex"}</small>
          {lead?.status === "idle" && discovery?.status === "running" &&
            <span className="waiting-note">Lead đang chờ báo cáo Discovery</span>}
          {lead?.status === "idle" && peers.some(p => p.status === "running") &&
            <span className="waiting-note">Lead đang chờ kết quả Peer</span>}
          {lead?.error && <p className="peer-error" role="alert">{lead.error}</p>}
        </div>
      </div>
    </div>
    {discovery && <div className="monitor-section">
      <div className="monitor-section-title"><h3>Discovery Session</h3><span>1</span></div>
      <div className="peer-unit">
        <button type="button" className="peer-card"
          aria-expanded={selectedPeerId === discovery.id}
          aria-controls={"transcript-" + discovery.id}
          onClick={() => onSelectPeer(selectedPeerId === discovery.id ? "" : discovery.id)}>
          <span className="avatar peer-avatar" aria-hidden="true">D</span>
          <span className="agent-info">
            <span className="agent-title"><strong>Discovery</strong>
              <span className={"status-chip " + sessionStatus(discovery).tone}>
                {sessionStatus(discovery).label}</span></span>
            <small>Khám phá sơ bộ · read-only · session riêng</small>
            <small>Model yêu cầu: {data.settings.discovery?.model || "Mặc định Discovery"}</small>
            <small>Effort: {data.settings.discovery?.effort || "Mặc định Discovery"}</small>
            <small className="turn-meta">{lastTurnText(discovery, data)}</small>
          </span>
          <span className="expand-chevron" aria-hidden="true">
            {selectedPeerId === discovery.id ? "⌃" : "⌄"}</span>
        </button>
        {selectedPeerId === discovery.id && <div className="peer-transcript"
          id={"transcript-" + discovery.id}>
          <div className="transcript-title">Báo cáo sơ bộ gửi Lead</div>
          {conversationMessages.filter(m => m.from === "discovery" &&
            m.discoverySessionId === discovery.id).map(m =>
            <div className="transcript-message" key={m.id}>
              <strong>Discovery <time dateTime={m.createdAt}>{shortTime(m.createdAt)}</time></strong>
              <div className="peer-message-content"><MarkdownContent content={m.text}/></div>
            </div>)}
          {!conversationMessages.some(m => m.from === "discovery" &&
            m.discoverySessionId === discovery.id) &&
            <p>Chưa có báo cáo sơ bộ.</p>}
          {discovery.error && <p className="peer-error" role="alert">{discovery.error}</p>}
        </div>}
      </div>
    </div>}
    <div className="monitor-section">
      <div className="monitor-section-title"><h3>Peer Sessions</h3><span>{peers.length}</span></div>
      <div className="peer-list">
        {peers.map(peer => {
          const status = sessionStatus(peer);
          const expanded = selectedPeerId === peer.id;
          return <div key={peer.id} className={"peer-unit " + (expanded ? "expanded" : "")}>
            <button type="button" className="peer-card" aria-expanded={expanded}
              aria-controls={"transcript-" + peer.id}
              onClick={() => onSelectPeer(expanded ? "" : peer.id)}>
              <span className="avatar peer-avatar" aria-hidden="true">{peer.moduleId?.slice(0, 1).toUpperCase() ?? "P"}</span>
              <span className="agent-info">
                <span className="agent-title"><strong>{peer.label}</strong>
                  <span className={"status-chip " + status.tone}>{status.label}</span></span>
                <small>{peer.moduleId} · {peer.id.slice(0, 8)}</small>
                <small>{peer.model || "Model mặc định Codex"} · {peer.effort || "Effort mặc định"}</small>
                <small className="turn-meta">{lastTurnText(peer, data)}</small>
              </span>
              <span className="expand-chevron" aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
            </button>
            {expanded && <PeerTranscript peer={peer} messages={conversationMessages}/>}
          </div>;
        })}
        {!peers.length && <p className="empty-peers">Lead chưa tạo Peer session nào.</p>}
      </div>
    </div>
    <div className="monitor-section">
      <div className="monitor-section-title"><h3>Sự kiện gần đây</h3></div>
      <ol className="activity-list">
        {events.map(event => <li key={event.id} className="activity-item">
          <span className={"activity-dot " + event.tone} aria-hidden="true"/>
          <span>{event.label}</span>
          <time dateTime={event.at}>{shortTime(event.at)}</time>
        </li>)}
        {!events.length && <li className="hint">Chưa có hoạt động được ghi nhận.</li>}
      </ol>
      <p className="activity-note">Tổng hợp từ messages đã lưu, không phải progress realtime của Codex.</p>
    </div>
    <div className="monitor-section modules-section">
      <div className="monitor-section-title"><h3>Modules đã cấu hình</h3>
        <span>{data.modules.length}</span></div>
      {data.modules.map(module => <div className="module-row" key={module.id}>
        <strong>{module.label}</strong><code title={module.path}>{module.path}</code>
      </div>)}
      {!data.modules.length && <p className="hint">Chưa cấu hình module.</p>}
    </div>
  </aside>;
}
