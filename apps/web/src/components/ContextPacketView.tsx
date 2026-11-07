import type { Decision, TaskBrief } from "@aacc/contracts";
import { MarkdownContent } from "./MarkdownContent.js";

/** Hiển thị chuỗi nguyên văn đã lưu tại thời điểm gọi runtime. */
export function ContextPacketView({ prompt }: { prompt?: string }) {
  return <details className="context-packet">
    <summary>Xem nội dung chuyển giao</summary>
    {prompt !== undefined
      ? <pre className="handoff-prompt">{prompt}</pre>
      : <p className="handoff-unavailable">Chưa có bản ghi nội dung chuyển giao cho lượt này.</p>}
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
