import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentRole, Snapshot, Task, WorkflowRun } from "@aacc/contracts";
import "./style.css";

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
const empty: Snapshot = { tasks: [], approvals: [], events: [], modules: [], workflows: [] };

function WorkflowCard({ workflow, onDecision, onSelect }: {
  workflow: WorkflowRun;
  onDecision: (id: string, decision: "approve" | "reject") => void;
  onSelect: (id: string) => void;
}) {
  return <div className="workflow">
    <div className="panel-heading">
      <div><strong>{workflow.title}</strong><p>{workflow.request}</p></div>
      <span className={"status " + workflow.status}>{workflow.status.replaceAll("_", " ")}</span>
    </div>
    <p className="muted">Lead reviews: {workflow.reviewCount} · Max reworks / Peer: {workflow.maxReworks}</p>
    {workflow.plan && <p><strong>Lead Plan:</strong> {workflow.plan.summary}</p>}
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
      {peer.feedback && <p className="muted"><strong>Lead feedback:</strong> {peer.feedback}</p>}
      {peer.attempts.map((attempt) => <button key={attempt.taskId} className="link-button"
        onClick={() => onSelect(attempt.taskId)}>Xem Task attempt #{attempt.iteration}</button>)}
    </div>)}</div>
    {workflow.error && <p className="error-text">{workflow.error}</p>}
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
  const visibleEvents = useMemo(() =>
    snapshot.events.filter((event) => !selectedTask || event.taskId === selectedTask).slice(-50).reverse()
  , [snapshot.events, selectedTask]);

  return <main>
    <header>
      <div>
        <p className="eyebrow">PERSONAL AI WORKSPACE · P1</p>
        <h1>AI Agent Control Center</h1>
        <p>Lead lập kế hoạch, phân công Peer tại source modules, review và chuyển kết quả cho bạn duyệt.</p>
      </div>
      <span className="tag">Local · Codex app-server</span>
    </header>
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
        <p className="muted">Đường dẫn cố định từ config local; Peer không tự chọn thư mục ngoài allowlist.</p>
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
        <h2>Runtime Approvals</h2>
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
            {task.error && <small className="error-text">{task.error}</small>}
          </div>)}</div>}
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>Activity</h2><button onClick={() => setSelectedTask("")}>Tất cả</button></div>
      <div className="events">
        {visibleEvents.map((event) => <div key={event.id} className="event">
          <small>{new Date(event.createdAt).toLocaleTimeString()} · {event.taskId.slice(0, 34)}</small>
          <strong>{event.kind}</strong>
          <pre>{JSON.stringify(event.data, null, 2)}</pre>
        </div>)}
      </div>
    </section>
    <footer>P1 — Lead/Peer automatic workflow. Chưa có Git worktree, recovery/resume sau restart hoặc merge tự động.</footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
