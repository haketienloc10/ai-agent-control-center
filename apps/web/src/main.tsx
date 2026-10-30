import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentRole, Snapshot, Task, WorkflowRun } from "@aacc/contracts";
import "./style.css";
import { ActivityPanel } from "./ActivityPanel.js";
import { ArtifactViewer } from "./ArtifactViewer.js";

async function api<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "API request failed");
  return data as T;
}
const empty: Snapshot = { tasks: [], approvals: [], events: [], modules: [], workflows: [], activities: [] };

function WorkflowCard({ workflow, onDecision, onRetryReview, onManualVerify, onRetryIntegration, onSelect }: {
  workflow: WorkflowRun;
  onDecision: (id: string, decision: "approve" | "reject") => void;
  onRetryReview: (id: string) => void;
  onManualVerify: (id: string, criterionIds: string[], contractIds: string[]) => void;
  onRetryIntegration: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const [verifiedCriteria, setVerifiedCriteria] = useState<string[]>([]);
  const [verifiedContracts, setVerifiedContracts] = useState<string[]>([]);
  useEffect(() => {
    setVerifiedCriteria([]);
    setVerifiedContracts([]);
  }, [workflow.integrationReviewCount, workflow.status]);
  const unverifiedChecks = workflow.finalReview?.checks.filter((check) => check.status === "unverified") ?? [];
  const unverifiedContracts = (workflow.finalReview?.contractChecks ?? [])
    .filter((check) => check.status === "unverified");
  return <div className="workflow">
    <div className="panel-heading">
      <div><strong>{workflow.title}</strong><p>{workflow.request}</p></div>
      <span className={"status " + workflow.status}>{workflow.status.replaceAll("_", " ")}</span>
    </div>
    <p className="muted">Lead reviews: {workflow.reviewCount} · Independent Final Reviews: {workflow.integrationReviewCount ?? 0} · Verification rounds: {workflow.verificationRounds ?? 0}/2 · Max reworks / Peer: {workflow.maxReworks}</p>
    {(workflow.reviewerTaskIds ?? []).length > 0 && <details className="acceptance-details">
      <summary>Final Reviewer · Fresh Codex Sessions ({workflow.reviewerTaskIds!.length})</summary>
      <p className="muted">Reviewer là role riêng, mỗi lượt có Codex Thread mới, không sử dụng session Lead.</p>
      {workflow.reviewerTaskIds!.map((taskId, i) =>
        <button type="button" className="link-button" key={taskId}
          onClick={() => onSelect(taskId)}>Xem Final Reviewer session #{i + 1}</button>
      )}
    </details>}
    {workflow.plan?.acceptanceCriteria && <details className="acceptance-details">
      <summary>Acceptance Criteria ({workflow.plan.acceptanceCriteria.length})</summary>
      <ol>{workflow.plan.acceptanceCriteria.map((criterion) => <li key={criterion.id}>
        <strong>{criterion.description}</strong>
        <p className="muted">Cách xác minh: {criterion.verification}</p>
      </li>)}</ol>
    </details>}
    {workflow.plan && <details className="acceptance-details">
      <summary>Integration Contracts ({(workflow.plan.integrationContracts ?? []).length}) ·
        {(workflow.plan.orderingOnlyDependencies ?? []).length} phụ thuộc chỉ theo thứ tự</summary>
      {(workflow.plan.integrationContracts ?? []).length === 0 && <p className="muted">Không có hợp đồng bàn giao xuyên module.</p>}
      {(workflow.plan.integrationContracts ?? []).map((contract) => <div key={contract.id} className="integration-check">
        <strong>{contract.producerTaskId} → {contract.consumerTaskId}: {contract.deliverable}</strong>
        <p className="muted">Cách sử dụng: {contract.consumerUsage}</p>
        <p className="muted">Cách kiểm tra: {contract.verification}</p>
      </div>)}
    </details>}
    {workflow.finalReview && <div className="integration-report">
      <h3>Final Integration Review · Independent Reviewer</h3>
      <p>{workflow.finalReview.summary}</p>
      <h3>Product Acceptance</h3>
      {workflow.finalReview.checks.map((check) => {
        const criterion = workflow.plan?.acceptanceCriteria.find((c) => c.id === check.criterionId);
        return <div key={check.criterionId} className="integration-check">
          <span className={"status " + (check.status === "passed" ? "accepted" : check.status === "failed" ? "failed" : "waiting_business_approval")}>
            {check.status === "passed" ? "Đạt" : check.status === "failed" ? "Chưa đạt" : "Chưa xác minh"}
          </span>
          <strong>{criterion?.description ?? check.criterionId}</strong>
          <p className="muted">{check.evidence}</p>
        </div>;
      })}
      {(workflow.finalReview.contractChecks ?? []).length > 0 && <h3>Integration Acceptance</h3>}
      {(workflow.finalReview.contractChecks ?? []).map((check) => {
        const contract = workflow.plan?.integrationContracts?.find((c) => c.id === check.contractId);
        return <div key={check.contractId} className="integration-check">
          <span className={"status " + (check.status === "passed" ? "accepted" : check.status === "failed" ? "failed" : "waiting_business_approval")}>
            {check.status === "passed" ? "Đạt" : check.status === "failed" ? "Chưa đạt" : "Chưa xác minh"}
          </span>
          <strong>{contract ? contract.producerTaskId + " → " + contract.consumerTaskId : check.contractId}</strong>
          <p className="muted">{contract?.deliverable} · {check.evidence}</p>
        </div>;
      })}
      {workflow.finalReview.rework.map((item) => <p key={item.taskId} className="error-text">
        Reviewer đề xuất sửa {item.taskId}: {item.feedback}
      </p>)}
      {workflow.lastRemediation && <div className="independent-test">
        <strong>Lead quyết định khắc phục:</strong> {workflow.lastRemediation.summary}
        {workflow.lastRemediation.rework.map((action) =>
          <p key={action.taskId}>Giao lại {action.taskId}: {action.feedback}</p>)}
      </div>}
    </div>}
    {workflow.lastVerificationDecision && <section className="lead-verification">
      <h3>Lead xử lý kết quả chưa xác minh</h3>
      <p><strong>Quyết định:</strong> {({
        collect_evidence: "Yêu cầu Peer bổ sung bằng chứng",
        run_verification: "Chạy kiểm chứng độc lập",
        request_human: "Cần người dùng hỗ trợ",
        blocked: "Đang bị chặn"
      } as const)[workflow.lastVerificationDecision.decision]}</p>
      <p><strong>Lý do:</strong> {workflow.lastVerificationDecision.reason}</p>
      <p><strong>Hướng xử lý:</strong> {workflow.lastVerificationDecision.instructions}</p>
      {workflow.lastVerificationDecision.taskIds.length > 0 &&
        <p className="muted">Peer: {workflow.lastVerificationDecision.taskIds.join(", ")}</p>}
    </section>}
    {workflow.status === "blocked" && <section className="manual-verification">
      <strong>Workflow đang bị chặn, chưa thể duyệt</strong>
      <p>{workflow.blocker}</p>
      <div className="actions">
        <button type="button" onClick={() => onDecision(workflow.id, "reject")}>Đóng workflow bị chặn</button>
      </div>
    </section>}
    {workflow.plan && <p><strong>Lead Plan:</strong> {workflow.plan.summary}</p>
    <div className="peers">{workflow.peers.map((peer) => <div key={peer.id} className="peer">
      <div className="panel-heading">
        <strong>{peer.title} · {peer.moduleId}</strong>
        <span className={"status " + peer.status}>{peer.status}</span>
      </div>
      <small>{peer.attempts.length} lần chạy · dependsOn: {peer.dependsOn.join(", ") || "none"}</small>
      {peer.result && <details>
        <summary>Kết quả & test evidence</summary>
        <p>{peer.result.summary}</p>
        <strong>Changed files</strong>
        <pre>{peer.result.changedFiles.join("\n") || "(none)"}</pre>
        <strong>Tests</strong>
        <pre>{JSON.stringify(peer.result.tests, null, 2)}</pre>
        <strong>Risks</strong>
        <pre>{JSON.stringify(peer.result.risks, null, 2)}</pre>
      </details>}
      {peer.evidence && <details>
        <summary>Git / Command evidence</summary>
        <strong>Git status trước / sau</strong>
        <pre>{peer.evidence.git.supported ? peer.evidence.git.statusBefore + "\\n--- AFTER ---\\n" +
          peer.evidence.git.statusAfter : "Git unavailable"}</pre>
        <strong>Diff stat & preview {peer.evidence.git.truncated ? "(truncated)" : ""}</strong>
        <pre>{peer.evidence.git.diffStat + "\\n" + peer.evidence.git.diffPreview}</pre>
        <strong>Artifact paths (đã kiểm tra)</strong>
        <pre>{JSON.stringify(peer.evidence.files, null, 2)}</pre>
        <strong>Tool command events</strong>
        <pre>{JSON.stringify(peer.evidence.commands, null, 2)}</pre>
      </details>}
      {peer.evidence?.patchArtifactId && <ArtifactViewer id={peer.evidence.patchArtifactId}/>}
      {peer.evidence?.verifiedTest && <div className="independent-test">
        <strong>Independent test runner:</strong>{" "}
        <span className={"status " + (peer.evidence.verifiedTest.status === "passed" ? "accepted" :
          peer.evidence.verifiedTest.status === "failed" ? "failed" : "")}>
          {peer.evidence.verifiedTest.status}
        </span>
        <p>{peer.evidence.verifiedTest.command || "Chưa cấu hình testCommand cho module"}</p>
        {peer.evidence.verifiedTest.output && <pre>{peer.evidence.verifiedTest.output}</pre>}
      </div>}
      {peer.feedback && <p className="muted"><strong>Lead feedback:</strong> {peer.feedback}</p>}
      {peer.attempts.map((attempt) => <button key={attempt.taskId} className="link-button"
        onClick={() => onSelect(attempt.taskId)}>Xem Task attempt #{attempt.iteration}</button>)}
    </div>)}</div>
    {workflow.error && <p className="error-text">{workflow.error}</p>}
    {workflow.status === "failed" && workflow.peers.length > 0 &&
      workflow.peers.every((p) => p.status === "accepted") &&
      (workflow.error?.startsWith("IntegrationReview sai schema") ||
        workflow.error?.startsWith("LeadRemediation sai schema") ||
        workflow.error?.startsWith("LeadVerification sai schema")) &&
      <div className="actions">
        <button className="primary" onClick={() => onRetryIntegration(workflow.id)}>
          {workflow.error?.startsWith("LeadRemediation sai schema") ||
           workflow.error?.startsWith("LeadVerification sai schema")
            ? "Thử lại quyết định Lead (không chạy lại Reviewer/Peer)"
            : "Thử lại Final Reviewer (fresh session, không chạy lại Peer)"}
        </button>
      </div>}
    {workflow.status === "failed" && workflow.peers.some((p) => p.status === "review_pending") &&
      <div className="actions">
        <button className="primary" onClick={() => onRetryReview(workflow.id)}>
          Thử lại Lead Review (không chạy lại Peer)
        </button>
      </div>}
    {workflow.status === "waiting_manual_verification" && workflow.finalReview &&
      <div className="manual-verification">
        <p><strong>Lead đã yêu cầu bạn hỗ trợ xác minh:</strong> chỉ sau khi Lead đánh giá việc kiểm chứng tự động không phù hợp hoặc chưa đủ.</p>
        {workflow.lastVerificationDecision?.decision === "request_human" &&
          <p>{workflow.lastVerificationDecision.instructions}</p>}
        <p className="muted">Chỉ xác nhận sau khi bạn tự thử nghiệm các chức năng liên quan. Đây không phải xác nhận test tự động đã chạy.</p>
        {unverifiedChecks.map((check) => {
          const criterion = workflow.plan?.acceptanceCriteria.find((c) => c.id === check.criterionId);
          return <label key={check.criterionId} className="manual-check">
            <input type="checkbox" checked={verifiedCriteria.includes(check.criterionId)}
              onChange={(event) => setVerifiedCriteria((previous) =>
                event.target.checked ? [...previous, check.criterionId] : previous.filter((id) => id !== check.criterionId))} />
            <span><strong>{criterion?.description ?? check.criterionId}</strong>
              <small>Cách kiểm tra: {criterion?.verification ?? "Thử nghiệm thủ công"}</small>
            </span>
          </label>;
        })}
        {unverifiedContracts.map((check) => {
          const contract = workflow.plan?.integrationContracts?.find((c) => c.id === check.contractId);
          return <label key={check.contractId} className="manual-check">
            <input type="checkbox" checked={verifiedContracts.includes(check.contractId)}
              onChange={(event) => setVerifiedContracts((previous) => event.target.checked
                ? [...previous, check.contractId] : previous.filter((id) => id !== check.contractId))} />
            <span><strong>Tích hợp: {contract?.producerTaskId} → {contract?.consumerTaskId}</strong>
              <small>{contract?.verification ?? "Xác minh hợp đồng tích hợp"}</small>
              <small>{check.evidence}</small>
            </span>
          </label>;
        })}
        <div className="actions">
          <button onClick={() => onDecision(workflow.id, "reject")}>Từ chối kết quả</button>
          <button className="primary" disabled={
            unverifiedChecks.some((c) => !verifiedCriteria.includes(c.criterionId)) ||
            unverifiedContracts.some((c) => !verifiedContracts.includes(c.contractId))
          }
            onClick={() => onManualVerify(workflow.id,
              unverifiedChecks.map((c) => c.criterionId),
              unverifiedContracts.map((c) => c.contractId))}>
            Xác nhận đã kiểm tra các tiêu chí
          </button>
        </div>
      </div>}
    {workflow.status === "waiting_business_approval" &&
      <div className="actions">
        <button onClick={() => onDecision(workflow.id, "reject")}>Từ chối kết quả</button>
        <button className="primary" onClick={() => onDecision(workflow.id, "approve")}>Duyệt kết quả</button>
      </div>}
  </div>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [role, setRole] = useState<AgentRole>("lead");
  const [moduleId, setModuleId] = useState("");
  const [wfTitle, setWfTitle] = useState("");
  const [wfRequest, setWfRequest] = useState("");
  const [error, setError] = useState("");
  const [selectedTask, setSelectedTask] = useState("");
  const [followupPrompt, setFollowupPrompt] = useState("");

  const refresh = async () => {
    try { setSnapshot(await api<Snapshot>("/snapshot")); }
    catch (err) { setError(String(err)); }
  };
  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/events");
    events.onmessage = () => { void refresh(); };
    events.onerror = () => setError("Mất kết nối SSE. Kiểm tra Backend.");
    return () => events.close();
  }, []);

  const runAction = async (path: string, body?: unknown) => {
    try {
      setError("");
      await api(path, "POST", body);
      await refresh();
    } catch (err) { setError(String(err)); }
  };
  const createManual = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setError("");
      const task = await api<Task>("/tasks", "POST", {
        title, prompt, role, ...(role === "peer" ? { moduleId } : {})
      });
      setSelectedTask(task.id);
      setTitle(""); setPrompt("");
      await refresh();
    } catch (err) { setError(String(err)); }
  };
  const createWorkflow = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setError("");
      await api<WorkflowRun>("/workflows", "POST", { title: wfTitle, request: wfRequest });
      setWfTitle(""); setWfRequest(""); setSelectedTask("");
      await refresh();
    } catch (err) { setError(String(err)); }
  };
  return <main>
    <header>
      <div>
        <p className="eyebrow">PERSONAL AI WORKSPACE · P2</p>
        <h1>AI Agent Control Center</h1>
        <p>Lead lập kế hoạch, phân công Peer tại source modules, review và chuyển kết quả cho bạn duyệt.</p>
      </div>
      <span className="tag">Local · Codex YOLO</span>
    </header>
    <p className="error" role="status">YOLO mode: Codex được quyền chạy lệnh và sửa file không cần Runtime Approval, kể cả ngoài module. Chỉ chạy trên máy cá nhân với repo tin cậy; Business Approval cuối workflow vẫn được giữ.</p>
    {error && <aside className="error" role="alert">{error} <button onClick={() => setError("")}>Đóng</button></aside>}
    <section className="columns">
      <article className="panel">
        <h2>Chạy Workflow Lead → Peer → Review</h2>
        <form onSubmit={createWorkflow}>
          <label>Tiêu đề <input required maxLength={200} value={wfTitle}
            onChange={(e) => setWfTitle(e.target.value)} placeholder="Triển khai authentication" /></label>
          <label>Yêu cầu <textarea required rows={6} maxLength={20000} value={wfRequest}
            onChange={(e) => setWfRequest(e.target.value)} placeholder="Lead phân tích và giao việc cho các module..." /></label>
          <button type="submit" className="primary">Tạo & chạy Workflow</button>
        </form>
        <p className="muted">Lead tạo plan JSON, Peer chạy theo dependency, Lead review tối đa 2 reworks/Peer.</p>
      </article>
      <article className="panel">
        <h2>Workspace & Modules</h2>
        <p className="muted">P2 dùng Git worktree tách khỏi source gốc. Module phải nằm trong Git repo đã commit sạch; thay đổi được xuất thành patch, không tự merge.</p>
        <div className="module"><strong>Lead Workspace</strong><span>config/workspace.local.json → lead.cwd</span></div>
        {snapshot.modules.map((m) => <div className="module" key={m.id}>
          <strong>{m.label}</strong><code>{m.path}</code>
        </div>)}
      </article>
    </section>
    <section className="panel">
      <h2>Workflows</h2>
      {snapshot.workflows.length === 0 && <p className="muted">Chưa có Workflow.</p>}
      {snapshot.workflows.map((workflow) => <WorkflowCard key={workflow.id} workflow={workflow}
        onDecision={(id, decision) => void runAction("/workflows/" + id + "/decision", { decision })}
        onRetryReview={(id) => void runAction("/workflows/" + id + "/retry-review")}
        onManualVerify={(id, criterionIds, contractIds) => void runAction("/workflows/" + id + "/confirm-verification", { criterionIds, contractIds })}
        onRetryIntegration={(id) => void runAction("/workflows/" + id + "/retry-integration")}
        onSelect={setSelectedTask} />)}
    </section>
    <section className="columns">
      <article className="panel">
        <h2>Chạy Agent riêng (Manual)</h2>
        <form onSubmit={createManual}>
          <label>Tiêu đề <input required maxLength={200} value={title}
            onChange={(e) => setTitle(e.target.value)} /></label>
          <label>Agent <select value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
            <option value="lead">Lead (workspace chung)</option>
            <option value="peer">Peer (source module)</option>
          </select></label>
          {role === "peer" && <label>Module <select required value={moduleId}
            onChange={(e) => setModuleId(e.target.value)}>
            <option value="">Chọn module</option>
            {snapshot.modules.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select></label>}
          <label>Prompt <textarea required rows={4} maxLength={20000} value={prompt}
            onChange={(e) => setPrompt(e.target.value)} /></label>
          <button className="primary" type="submit">Tạo Task</button>
        </form>
      </article>
      <article className="panel">
        <h2>Runtime Approvals (bỏ qua khi YOLO)</h2>
        {snapshot.approvals.filter((a) => a.status === "pending").length === 0 &&
          <p className="muted">Không có yêu cầu chờ duyệt.</p>}
        {snapshot.approvals.filter((a) => a.status === "pending").map((approval) =>
          <div className="approval" key={approval.id}>
            <strong>{approval.method}</strong>
            <pre>{JSON.stringify(approval.params, null, 2)}</pre>
            <div className="actions">
              <button onClick={() => void runAction("/approvals/" + approval.id + "/decision", { decision: "decline" })}>Từ chối</button>
              <button className="primary" onClick={() => void runAction("/approvals/" + approval.id + "/decision", { decision: "accept" })}>Cho phép</button>
            </div>
          </div>)}
      </article>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>Tasks / Codex Sessions</h2><button onClick={() => void refresh()}>Làm mới</button></div>
      {snapshot.tasks.length === 0 ? <p className="muted">Chưa có Task.</p> :
        <div className="task-list">{snapshot.tasks.map((task) =>
          <div key={task.id} className={"task " + (selectedTask === task.id ? "selected" : "")}>
            <button className="task-title" onClick={() => setSelectedTask(task.id)}>
              <strong>{task.title}</strong><small>{task.role.toUpperCase()} {task.moduleId ? " · " + task.moduleId : ""}
                {task.workflowId ? " · Workflow " + task.workflowId.slice(0, 8) : ""}
              </small>
            </button>
            <span className={"status " + task.status}>{task.status}</span>
            {task.status === "queued" && !task.workflowId &&
              <button onClick={() => void runAction("/tasks/" + task.id + "/run")}>Run</button>}
            {["running", "waiting_runtime_approval"].includes(task.status) &&
              <button onClick={() => void runAction("/tasks/" + task.id + "/interrupt")}>Interrupt</button>}
            {task.executionCwd && <small className="worktree-path">Worktree: {task.executionCwd}</small>}
            {task.status === "completed" && task.role === "peer" && !task.workflowId && task.executionCwd &&
              <button type="button" onClick={() =>
                void runAction("/tasks/" + task.id + "/export-patch")}>Xuất patch</button>}
            {(snapshot.artifacts ?? []).filter((a) => a.taskId === task.id && a.kind === "patch").map(
              (a) => <ArtifactViewer key={a.id} id={a.id} label="Xem patch đã lưu" />
            )}
            {task.status === "interrupted" && <button type="button" onClick={() =>
              void runAction("/tasks/" + task.id + "/reconcile")}>Reconcile</button>}
            {task.reconciliation && <small className="recovery-detail">
              Recovery: {task.reconciliation.status} — {task.reconciliation.detail}</small>}
            {task.role !== "reviewer" && task.reconciliation?.status === "completed" && selectedTask === task.id &&
              <div className="recovery-followup">
                <label>Follow-up mới trên Thread cũ (không chạy lại prompt trước)
                  <textarea rows={2} value={followupPrompt} onChange={(event) => setFollowupPrompt(event.target.value)}
                    placeholder="Tiếp tục kiểm tra, không lặp các thay đổi đã hoàn thành…" />
                </label>
                <button disabled={!followupPrompt.trim()} onClick={() => {
                  void runAction("/tasks/" + task.id + "/continue", { prompt: followupPrompt });
                  setFollowupPrompt("");
                }}>Chạy follow-up có chủ đích</button>
              </div>}
            {task.error && <small className="error-text">{task.error}</small>}
          </div>)}</div>}
    </section>
    <ActivityPanel
      activities={snapshot.activities ?? []}
      events={snapshot.events}
      tasks={snapshot.tasks}
      workflows={snapshot.workflows}
      modules={snapshot.modules}
      selectedTask={selectedTask}
      onSelectTask={setSelectedTask}
    />
    <footer>P2 — Lead điều phối · Peer triển khai · Final Reviewer độc lập trong fresh session · Bạn duyệt.</footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
