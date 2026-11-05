import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Conversation, Snapshot } from "@aacc/contracts";
import { AgentSettingsModal } from "./AgentSettingsModal.js";
import { Sidebar, type ConnectionState } from "./components/Sidebar.js";
import { TaskHeader } from "./components/TaskHeader.js";
import { ConversationFeed } from "./components/ConversationFeed.js";
import { MessageComposer } from "./components/MessageComposer.js";
import { AgentMonitor } from "./components/AgentMonitor.js";
import { NewTaskModal } from "./components/NewTaskModal.js";
import "./style.css";

const empty: Snapshot = {
  modules: [], conversations: [], sessions: [], messages: [], deliveries: [],
  settings: { lead: {}, peer: {} }
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, body === undefined
    ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "HTTP " + response.status);
  return result;
}
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function App() {
  const [data, setData] = useState<Snapshot>(empty);
  const [selectedId, setSelectedId] = useState("");
  const [peerFocus, setPeerFocus] = useState("");
  const [draft, setDraft] = useState("");
  const [newRequest, setNewRequest] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showRouting, setShowRouting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const requestVersion = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const current = ++requestVersion.current;
    try {
      const result = await api<Snapshot>("/snapshot");
      if (current === requestVersion.current) {
        setData(result);
        setError("");
      }
    } catch (cause) {
      if (current === requestVersion.current) setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/events");
    events.onopen = () => setConnection("connected");
    events.onmessage = () => { void refresh(); };
    events.onerror = () => setConnection("offline");
    return () => { events.close(); };
  }, [refresh]);

  const conversations = useMemo(
    () => [...data.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [data.conversations]
  );
  const activeId = selectedId && conversations.some(c => c.id === selectedId)
    ? selectedId : (conversations[0]?.id ?? "");
  const conversation = conversations.find(c => c.id === activeId);
  const sessions = data.sessions.filter(s => s.conversationId === activeId);

  const submitNew = async () => {
    if (!newRequest.trim() || sending) return;
    setSending(true); setError("");
    try {
      const created = await api<Conversation>("/conversations", { text: newRequest.trim() });
      setSelectedId(created.id);
      setPeerFocus("");
      setNewRequest("");
      setShowNew(false);
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setSending(false); }
  };

  const sendMessage = async () => {
    if (!draft.trim() || !activeId || sending) return;
    setSending(true); setError("");
    try {
      await api("/conversations/" + activeId + "/messages", { text: draft.trim() });
      setDraft("");
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setSending(false); }
  };

  return <div className="shell">
    <Sidebar data={data} conversations={conversations} activeId={activeId}
      connection={connection} onSelect={id => { setSelectedId(id); setPeerFocus(""); }}
      onNew={() => setShowNew(true)} onSettings={() => setShowSettings(true)}/>
    <main className="workspace">
      {error && <div className="error-banner" role="alert">
        <span>{error}</span>
        <button type="button" onClick={() => { setError(""); void refresh(); }}>Thử lại</button>
      </div>}
      {conversation ? <>
        <TaskHeader data={data} conversation={conversation}/>
        <div className="content">
          <div className="conversation-column">
            <ConversationFeed conversationId={activeId} messages={data.messages}
              sessions={sessions} showRouting={showRouting} onRoutingChange={setShowRouting}/>
            <MessageComposer value={draft} onChange={setDraft}
              onSend={() => { void sendMessage(); }} sending={sending}/>
          </div>
          <AgentMonitor data={data} conversation={conversation}
            selectedPeerId={peerFocus} onSelectPeer={setPeerFocus}/>
        </div>
      </> : <section className="welcome">
        <span className="welcome-mark" aria-hidden="true">L</span>
        <h1>Điều phối công việc cùng Lead</h1>
        <p>Giao yêu cầu cho Lead. Khi các Peer hoàn thành hoặc gặp lỗi, hệ thống tự gửi kết quả
          về Lead mà không cần hỏi tiến độ.</p>
        <button type="button" className="primary" onClick={() => setShowNew(true)}>
          ＋ Giao việc đầu tiên
        </button>
      </section>}
    </main>
    {showSettings && <AgentSettingsModal initial={data.settings}
      onClose={() => setShowSettings(false)} onSaved={refresh}/>}
    {showNew && <NewTaskModal value={newRequest} onChange={setNewRequest}
      onClose={() => setShowNew(false)} onSubmit={() => { void submitNew(); }} sending={sending}/>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
