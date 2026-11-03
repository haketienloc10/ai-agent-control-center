import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentSession, Conversation, Message, Snapshot } from "@aacc/contracts";
import { visibleMessages, peerMessages } from "./message-view.js";
import "./style.css";

const empty: Snapshot = { modules: [], conversations: [], sessions: [], messages: [], deliveries: [] };
const time = (iso: string) => new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
async function api<T>(path: string, data?: unknown): Promise<T> {
  const res = await fetch("/api" + path, data === undefined
    ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const json = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? "HTTP " + res.status);
  return json;
}

function displayFrom(message: Message, sessions: AgentSession[]): string {
  if (message.from === "user") return "Bạn";
  if (message.from === "lead") return "Lead";
  if (message.from === "system") return "Hệ thống";
  return sessions.find(s => s.id === message.peerSessionId)?.label ?? "Peer";
}
function MessageItem({ message, sessions }: { message: Message; sessions: AgentSession[] }) {
  const label = displayFrom(message, sessions);
  return <article className={"bubble bubble-" + message.from}>
    <div className="bubble-heading"><strong>{label}</strong><span className="route">
      {message.to === "peer" ? "→ Peer" : message.to === "lead" ? "→ Lead" : "→ Bạn"}
    </span><time>{time(message.createdAt)}</time></div>
    <div className="bubble-body">{message.text}</div>
  </article>;
}

function App() {
  const [data, setData] = useState<Snapshot>(empty);
  const [selected, setSelected] = useState<string>("");
  const [peerFocus, setPeerFocus] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [newRequest, setNewRequest] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showRouting, setShowRouting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const lastMessage = useRef<HTMLDivElement>(null);
  const refresh = async () => {
    try { const next = await api<Snapshot>("/snapshot"); setData(next); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/events");
    events.onmessage = () => { void refresh(); };
    events.onerror = () => setError("Mất kết nối Backend, đang thử kết nối lại…");
    return () => events.close();
  }, []);
  const conversations = useMemo(() => [...data.conversations].reverse(), [data.conversations]);
  const activeId = selected && data.conversations.some(c => c.id === selected)
    ? selected : conversations[0]?.id ?? "";
  const conversation = data.conversations.find(c => c.id === activeId);
  const sessions = data.sessions.filter(s => s.conversationId === activeId);
  const peers = sessions.filter(s => s.role === "peer");
  const allMessages = data.messages.filter(m => m.conversationId === activeId);
  const feed = visibleMessages(data.messages, activeId, showRouting);
  const focussedPeer = peers.find(s => s.id === peerFocus);
  const selectedPeerMessages = peerMessages(allMessages, focussedPeer?.id ?? "");
  const working = sessions.filter(s => s.status === "running");
  const waiting = data.deliveries.filter(d => d.conversationId === activeId && d.status === "queued");
  useEffect(() => { lastMessage.current?.scrollIntoView({ block: "end", behavior: "smooth" }); },
    [activeId, feed.length, showRouting]);
  const submitNew = async () => {
    if (!newRequest.trim() || sending) return;
    setSending(true); setError("");
    try {
      const next = await api<Conversation>("/conversations", { text: newRequest });
      setSelected(next.id); setNewRequest(""); setShowNew(false); setPeerFocus("");
      await refresh();
    } catch (cause) { setError(String(cause)); }
    finally { setSending(false); }
  };
  const sendMessage = async () => {
    if (!draft.trim() || !activeId || sending) return;
    setSending(true); setError("");
    try {
      await api("/conversations/" + activeId + "/messages", { text: draft });
      setDraft(""); await refresh();
    } catch (cause) { setError(String(cause)); }
    finally { setSending(false); }
  };
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon">AC</span>
        <div><strong>Agent Control Center</strong><small>LEAD ↔ PEER · LOCAL MVP</small></div></div>
      <button type="button" className="primary full" onClick={() => setShowNew(true)}>
        + Yêu cầu mới cho Lead
      </button>
      <div className="side-heading">Các cuộc việc <span>{conversations.length}</span></div>
      <nav className="conversation-list" aria-label="Conversations">
        {conversations.map(c => <button key={c.id} type="button"
          className={"conversation-link " + (c.id === activeId ? "chosen" : "")}
          onClick={() => { setSelected(c.id); setPeerFocus(""); }}>
          <span className="conversation-icon">⌘</span>
          <span className="conversation-meta"><strong>{c.title}</strong>
            <small>{c.status === "finished" ? "Lead đã kết thúc" : "Đang trao đổi"}</small></span>
        </button>)}
        {!conversations.length && <p className="hint">Bắt đầu bằng cách giao việc cho Lead.</p>}
      </nav>
      <div className="sidebar-footer">
        <span className="live-dot"/> Codex app-server · localhost
        <small>Không Workflow gate · Không Git worktree</small>
      </div>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <div><small className="eyebrow">WORKSPACE / LEAD</small>
          <h1>{conversation?.title ?? "Điều phối nhiều AI Agents"}</h1>
          <p>{conversation
            ? "Bạn trao đổi với Lead. Lead quản lý các Peer sessions trong từng module."
            : "Một Lead ở workspace; nhiều Peer sessions ở các module; không Peer-to-Peer."}</p>
        </div>
        {conversation && <span className={"pill " + (working.length ? "busy" : "")}>
          <span className="live-dot"/> {working.length
            ? working.length + " Agent đang chạy" : conversation.status === "finished"
            ? "Lead đã kết thúc" : "Sẵn sàng"}</span>}
      </header>
      {error && <div role="alert" className="error">{error}
        <button onClick={() => { setError(""); void refresh(); }}>Thử lại</button></div>}
      {!conversation ? <section className="welcome">
        <div className="welcome-mark">L</div>
        <h2>Chỉ cần nói chuyện với Lead</h2>
        <p>Lead tự mở Peer sessions, giao việc, đọc kết quả, xử lý blocker và quyết định hoàn thành.</p>
        <div className="welcome-example">Ví dụ: “Xem module Web và tạo file README.md”</div>
        <button className="primary" onClick={() => setShowNew(true)}>Giao việc đầu tiên</button>
      </section> : <>
        <div className="content">
          <section className="chat-panel" aria-label="Hội thoại với Lead">
            <div className="section-header"><div><h2>Hội thoại</h2>
              <span className="hint">Mọi công việc đều được Lead điều phối</span></div>
              <label className="routing-toggle">
                <input type="checkbox" checked={showRouting}
                  onChange={e => setShowRouting(e.target.checked)}/>
                Xem cả luồng Lead ↔ Peer
              </label>
            </div>
            <div className="chat-feed">
              {feed.map(m => <MessageItem key={m.id} message={m} sessions={sessions}/>)}
              <div ref={lastMessage}/>
            </div>
            <form className="composer" onSubmit={e => { e.preventDefault(); void sendMessage(); }}>
              <label htmlFor="message-input" className="sr-only">Nhắn Lead</label>
              <textarea id="message-input" placeholder="Nhắn Lead: hỏi tiến độ, giao thêm việc, giải quyết vấn đề…"
                value={draft} rows={3} onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault(); void sendMessage();
                } }}/>
              <div className="composer-footer"><span>Enter gửi · Shift+Enter xuống dòng</span>
                <button className="primary" disabled={sending || !draft.trim()}>Gửi Lead</button></div>
            </form>
          </section>
          <aside className="agents-panel">
            <div className="section-header"><div><h2>Agent Sessions</h2>
              <span className="hint">{peers.length} Peer · {waiting.length} message chờ</span></div></div>
            <div className="lead-card">
              <span className="avatar lead-avatar">L</span>
              <div><strong>Lead Agent</strong><small>Workspace chung</small>
                <span className={"session-status " + (sessions.find(s => s.role === "lead")?.status ?? "idle")}>
                  {sessions.find(s => s.role === "lead")?.status ?? "idle"}</span>
              </div></div>
            <div className="module-heading">Peer sessions</div>
            <div className="peer-list">
              {peers.map(peer => <button key={peer.id} type="button"
                className={"peer-card " + (peerFocus === peer.id ? "active" : "")}
                onClick={() => setPeerFocus(peerFocus === peer.id ? "" : peer.id)}>
                <span className="avatar">P</span>
                <span><strong>{peer.label}</strong><small>{peer.moduleId} · {peer.id.slice(0, 8)}</small>
                  <span className={"session-status " + peer.status}>{peer.status}</span></span>
              </button>)}
              {!peers.length && <div className="empty-peers">Lead chưa mở Peer session nào.</div>}
            </div>
            {focussedPeer && <div className="peer-transcript">
              <div className="section-header"><h3>{focussedPeer.label}</h3>
                <button onClick={() => setPeerFocus("")}>Đóng</button></div>
              <p>Chỉ Lead có quyền gửi yêu cầu đến Peer này.</p>
              {selectedPeerMessages.map(m => <div className="transcript-message" key={m.id}>
                <strong>{displayFrom(m, sessions)} → {m.to === "lead" ? "Lead" : "Peer"}</strong>
                <p>{m.text}</p></div>)}
              {focussedPeer.error && <p className="peer-error">{focussedPeer.error}</p>}
            </div>}
            <div className="module-heading">Modules đã cấu hình</div>
            {data.modules.map(m => <div className="module-row" key={m.id}>
              <strong>{m.label}</strong><code title={m.path}>{m.path}</code>
            </div>)}
          </aside>
        </div>
      </>}
    </main>
    {showNew && <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-label="Giao yêu cầu mới">
        <div className="section-header"><h2>Yêu cầu mới cho Lead</h2>
          <button onClick={() => setShowNew(false)}>Đóng</button></div>
        <p>Lead sẽ chủ động chọn các Peer sessions và điều phối đến khi hoàn thành.</p>
        <form onSubmit={e => { e.preventDefault(); void submitNew(); }}>
          <label htmlFor="new-request">Yêu cầu</label>
          <textarea id="new-request" autoFocus rows={6}
            placeholder="Ví dụ: Xem module Web và tạo README.md…" value={newRequest}
            onChange={e => setNewRequest(e.target.value)}/>
          <button className="primary full" disabled={sending || !newRequest.trim()}>
            {sending ? "Đang gửi…" : "Gửi Lead"}</button>
        </form>
      </section>
    </div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
