import { useEffect, useId, useRef, useState } from "react";
import { MarkdownContent } from "./MarkdownContent.js";
import { ContextPacketView } from "./ContextPacketView.js";
import type { AgentSession, Message } from "@aacc/contracts";
import { visibleMessages } from "../message-view.js";
import { shortTime } from "../selectors.js";

/** Expand the rendered content, not a sliced Markdown string. */
export function MessageBody({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const long = text.length > 720;
  return <div className="message-body-container">
    <div id={contentId} className={"message-body" + (long && !expanded ? " is-collapsed" : "")}>
      <MarkdownContent content={text}/>
    </div>
    {long && <button type="button" className="message-expand"
      aria-expanded={expanded} aria-controls={contentId}
      onClick={() => setExpanded(previous => !previous)}>
      {expanded ? "Thu gọn" : "Xem toàn bộ"} <span aria-hidden="true">{expanded ? "↑" : "↓"}</span>
    </button>}
  </div>;
}
function MessageRow({ message, sessions }: { message: Message; sessions: AgentSession[] }) {
  const peer = sessions.find(s => s.id === message.peerSessionId)?.label ?? "Peer";
  const routed = message.to === "peer" || message.to === "discovery" ||
    message.from === "discovery" ||
    (message.from === "peer" && message.to === "lead") ||
    (message.from === "system" && message.to === "lead");
  if (routed) {
    const label = message.to === "peer" ? "Lead giao việc cho " + peer :
      message.to === "discovery" ? "Lead giao Discovery khảo sát sơ bộ" :
      message.from === "peer" ? peer + " gửi kết quả" :
      message.from === "discovery" ? "Discovery gửi báo cáo sơ bộ cho Lead" :
      "Hệ thống gửi thông tin cho Lead";
    return <details className="route-event">
      <summary><span className="event-mark" aria-hidden="true">↳</span>
        <strong>{label}</strong><time>{shortTime(message.createdAt)}</time></summary>
      <div className="event-detail">
        <MarkdownContent content={message.text}/>
        {(message.contextPacket || message.handoffPrompt !== undefined) && <ContextPacketView prompt={message.handoffPrompt}/>}
      </div>
    </details>;
  }
  const author = message.from === "user" ? "Bạn" :
    message.from === "lead" ? "Lead" : "Hệ thống";
  return <article className={"chat-message message-" + message.from}>
    <span className="message-avatar" aria-hidden="true">
      {message.from === "user" ? "B" : message.from === "lead" ? "L" : "i"}
    </span>
    <div className="message-content">
      <div className="message-heading"><strong>{author}</strong>
        <time dateTime={message.createdAt}>{shortTime(message.createdAt)}</time></div>
      <MessageBody text={message.text}/>
    </div>
  </article>;
}

export function ConversationFeed({ messages, sessions, conversationId, showRouting, onRoutingChange }: {
  messages: Message[];
  sessions: AgentSession[];
  conversationId: string;
  showRouting: boolean;
  onRoutingChange: (show: boolean) => void;
}) {
  const feed = visibleMessages(messages, conversationId, showRouting);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }, [conversationId, feed.length, showRouting]);
  return <section className="chat-panel" aria-label="Hội thoại với Lead">
    <div className="section-header chat-header">
      <div><h2>Hội thoại</h2>
        <p>Theo dõi trao đổi và kết quả điều phối.</p></div>
      <label className="routing-toggle">
        <input type="checkbox" checked={showRouting}
          onChange={e => onRoutingChange(e.target.checked)}/>
        <span>Xem luồng điều phối</span>
      </label>
    </div>
    <div className="chat-feed" role="log" aria-label="Lịch sử hội thoại">
      {feed.map(m => <MessageRow key={m.id} message={m} sessions={sessions}/>)}
      {!feed.length && <div className="empty-chat">Chưa có tin nhắn trong cuộc việc này.</div>}
      <div ref={endRef}/>
    </div>
  </section>;
}
