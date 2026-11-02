import { useMemo, useState } from "react";
import type { AgentRole, ModuleConfig, Task, WorkflowRun } from "@aacc/contracts";

export interface AgentMapNode {
  id: string; role: AgentRole; label: string; moduleId?: string;
  task?: Task; status: string; count: number; detail?: string;
}
const running = new Set(["starting", "running", "waiting_runtime_approval"]);
/** Pure projection of persisted tasks, never fabricate activity for an idle agent. */
export function agentMapNodes(modules: ModuleConfig[], tasks: Task[],
  workflowId?: string, workflows: WorkflowRun[] = []): AgentMapNode[] {
  const scoped = tasks.filter(t => !workflowId || t.workflowId === workflowId);
  const nodes: AgentMapNode[] = [
    { id: "lead", role: "lead", label: "Lead · Điều phối", status: "idle", count: 0 },
    ...modules.map(module => ({
      id: "peer:" + module.id, role: "peer" as const,
      label: module.label, moduleId: module.id, status: "idle", count: 0
    })),
    { id: "reviewer", role: "reviewer", label: "Final Reviewer", status: "idle", count: 0 }
  ];
  return nodes.map(node => {
    const matches = scoped.filter(t => t.role === node.role &&
      (node.role !== "peer" || t.moduleId === node.moduleId));
    const task = matches.find(t => running.has(t.status)) ?? matches[0];
    const current = workflows.find(w => w.id === workflowId);
    const peers = node.role === "peer"
      ? current?.peers.filter(peer => peer.moduleId === node.moduleId) ?? [] : [];
    const failed = peers.find(peer => peer.status === "failed");
    const skipped = peers.find(peer => peer.status === "skipped");
    const outcome = failed ?? skipped;
    // Module status reflects PeerWork even if the Task never reached Codex.
    // An actual running Task has priority, otherwise show the failed/skipped handoff.
    const status = task && running.has(task.status) ? task.status :
      outcome?.status ?? task?.status ?? "idle";
    return { ...node, task, count: matches.filter(t => running.has(t.status)).length,
      status, detail: outcome?.feedback };
  });
}

export function AgentMap({ modules, tasks, workflows, onSelectTask }: {
  modules: ModuleConfig[]; tasks: Task[]; workflows: WorkflowRun[];
  onSelectTask: (id: string) => void;
}) {
  const [selectedWorkflow, setSelectedWorkflow] = useState("");
  const current = selectedWorkflow && workflows.some(w => w.id === selectedWorkflow)
    ? selectedWorkflow : workflows[0]?.id ?? "";
  const nodes = useMemo(() => agentMapNodes(modules, tasks, current || undefined, workflows),
    [modules, tasks, current, workflows]);
  const lead = nodes.filter(n => n.role === "lead");
  const peers = nodes.filter(n => n.role === "peer");
  const reviewers = nodes.filter(n => n.role === "reviewer");
  const renderNode = (node: AgentMapNode) =>
    <button key={node.id} className={"agent-tile agent-tile-" + node.role}
      type="button" onClick={() => node.task && onSelectTask(node.task.id)}
      disabled={!node.task}
      aria-label={node.label + ", " + node.status}>
      <span className="agent-tile-icon" aria-hidden="true">{node.role === "lead" ? "L" :
        node.role === "reviewer" ? "R" : "P"}</span>
      <span className="agent-tile-info">
        <strong>{node.label}</strong>
        <small>{node.task?.title ?? (node.status === "skipped"
          ? "Bị bỏ qua trước khi tạo session" : "Chưa có session")}</small>
        {node.detail && <small className="agent-failure-detail" title={node.detail}>
          {node.detail.length > 150 ? node.detail.slice(0, 150) + "…" : node.detail}
        </small>}
        <span className={"agent-tile-status agent-status-" + node.status}>
          {node.count > 0 ? node.count + " đang chạy" : node.status}
        </span>
      </span>
    </button>;
  return <section className="panel agent-map-panel" aria-label="Bản đồ Agent">
    <div className="panel-heading">
      <div><h2>Bản đồ Agent · Live</h2>
        <p className="muted">Lead điều phối → Peer triển khai → Final Reviewer kiểm tra độc lập.</p></div>
      <label className="map-workflow-label">Workflow
        <select value={current} onChange={e => setSelectedWorkflow(e.target.value)}>
          {workflows.length === 0 && <option value="">Chưa có Workflow</option>}
          {workflows.map(w => <option key={w.id} value={w.id}>{w.title} · {w.status}</option>)}
        </select>
      </label>
    </div>
    <div className="agent-map-stage">
      <div className="agent-map-track">
        <div className="agent-map-lane"><h3>Điều phối</h3>{lead.map(renderNode)}</div>
        <span className="agent-map-connector" aria-hidden="true">→</span>
        <div className="agent-map-lane agent-map-peers"><h3>Triển khai · {peers.length} modules</h3>
          {peers.length ? peers.map(renderNode) : <p>Chưa cấu hình Peer module</p>}
        </div>
        <span className="agent-map-connector" aria-hidden="true">→</span>
        <div className="agent-map-lane"><h3>Đánh giá độc lập</h3>{reviewers.map(renderNode)}</div>
      </div>
    </div>
    <p className="muted map-footnote">Chọn một Agent để xem session gần nhất trong workflow.
      Trạng thái “idle” chỉ có nghĩa chưa có Task, không suy diễn Agent đang xử lý.</p>
  </section>;
}
