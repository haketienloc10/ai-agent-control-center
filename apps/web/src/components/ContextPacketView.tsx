import type { ContextPacket, Decision, TaskBrief } from "@aacc/contracts";
import { MarkdownContent } from "./MarkdownContent.js";

/** Renders the immutable handoff actually stored on the worker delivery. */
export function ContextPacketView({ packet }: { packet: ContextPacket }) {
  return <details className="context-packet">
    <summary>Context Packet đã gửi cho agent · {packet.sources.length} nguồn</summary>
    <div className="context-packet-body">
      {packet.originalRequest ? <>
        <strong>ORIGINAL_USER_REQUEST · {packet.originalRequest.messageId}</strong>
        <MarkdownContent content={packet.originalRequest.text}/>
      </> : <p>ORIGINAL_USER_REQUEST: đã có trong Thread của agent từ lượt trước.</p>}
      {packet.taskBrief && <div>
        <strong>TASK_BRIEF_FROM_LEAD</strong>
        <TaskBriefView brief={packet.taskBrief} compact/>
      </div>}
      {packet.omitted?.taskBrief && <p>TASK_BRIEF_FROM_LEAD: không đổi so với lượt trước.</p>}
      <strong>SUPPORTING_CONTEXT · nguồn nguyên văn</strong>
      {packet.sources.map(source => <div key={source.messageId}>
        <small>{source.kind} · {source.from} · {source.messageId}</small>
        <MarkdownContent content={source.text}/>
      </div>)}
      {!packet.sources.length && <p>Lead không đính kèm nguồn bổ sung.</p>}
      {!!packet.omitted?.sourceIds?.length && <p>
        Không gửi lại (đã có trong Thread): {packet.omitted.sourceIds.join(", ")}</p>}
      {!!packet.decisions?.length && <div>
        <strong>DECISIONS_FROM_LEAD</strong>
        <DecisionLogView decisions={packet.decisions}/>
      </div>}
      {!!packet.omitted?.decisionIds?.length && <p>
        Quyết định đã có trong Thread: {packet.omitted.decisionIds.join(", ")}</p>}
      <strong>LEAD_EXPECTED_RESULT</strong>
      <MarkdownContent content={packet.expectedResult}/>
    </div>
  </details>;
}

/** Lead-owned assessment, not an App-certified verification gate. */
export function TaskBriefView({ brief, compact = false }: { brief: TaskBrief; compact?: boolean }) {
  return <div className={"task-brief" + (compact ? " compact" : "")}>
    <p><strong>Mục tiêu:</strong> {brief.goal}</p>
    <p><strong>Tiêu chí hoàn thành:</strong></p>
    <ul>{brief.acceptanceCriteria.map((item, i) => <li key={i}>{item}</li>)}</ul>
    {brief.verified.length > 0 && <><p><strong>Lead đánh giá đã xác minh:</strong></p>
      <ul>{brief.verified.map((item, i) => <li key={i}>{item.finding}
        <small> (Nguồn: {item.evidenceRefs.join(", ")})</small></li>)}</ul></>}
    {brief.preliminary.length > 0 && <><p><strong>Nhận định sơ bộ:</strong></p>
      <ul>{brief.preliminary.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
    {brief.unknowns.length > 0 && <><p><strong>Chưa rõ:</strong></p>
      <ul>{brief.unknowns.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
    <p><strong>Quyết định tiếp theo:</strong> {brief.nextDecision}</p>
  </div>;
}

/** Current decision per topic first; replaced versions stay visible as history. */
export function DecisionLogView({ decisions }: { decisions: Decision[] }) {
  const replaced = new Set(decisions.flatMap(d => d.supersedes ? [d.supersedes] : []));
  return <ul className="decision-log">
    {decisions.slice().reverse().map(d => <li key={d.id}
      className={replaced.has(d.id) ? "superseded" : undefined}>
      <p><strong>{d.topic}</strong>{replaced.has(d.id) && <small> · đã bị thay</small>}
        <small> · {d.affects.join(", ")}</small></p>
      <MarkdownContent content={d.decision}/>
      <p><small>Lý do: {d.rationale}</small></p>
      {d.evidenceRefs.length > 0 && <p><small>Căn cứ: {d.evidenceRefs.join(", ")}</small></p>}
    </li>)}
  </ul>;
}
