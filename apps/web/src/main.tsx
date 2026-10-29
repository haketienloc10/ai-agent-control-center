import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentRole, Snapshot, Task } from "@aacc/contracts";
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

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ tasks: [], approvals: [], events: [], modules: [] });
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [role, setRole] = useState<AgentRole>("lead");
  const [moduleId, setModuleId] = useState("");
  const [error, setError] = useState("");
  const [selectedTask, setSelectedTask] = useState<string>("");

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
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setError("");
      const newTask = await api<Task>("/tasks", "POST", {
        title, prompt, role, ...(role === "peer" ? { moduleId } : {})
      });
      setSelectedTask(newTask.id);
      setTitle("");
      setPrompt("");
      await refresh();
    } catch (err) { setError(String(err)); }
  };

  const visibleEvents = useMemo(() => {
    return snapshot.events.filter((event) => !selectedTask || event.taskId === selectedTask).slice(-35).reverse();
  }, [snapshot.events, selectedTask]);

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">PERSONAL AI WORKSPACE</p>
          <h1>AI Agent Control Center</h1>
          <p>Lead điều phối tại workspace chung. Peer thực thi tại source module đã đăng ký.</p>
        </div>
        <span className="tag">Local · Codex app-server</span>
      </header>
      {error && <aside className="error" role="alert">{error} <button onClick={() => setError("")}>Đóng</button></aside>}
      <section className="columns">
        <article className="panel">
          <h2>Tạo nhiệm vụ</h2>
          <form onSubmit={create}>
            <label>Tiêu đề <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ví dụ: Review thay đổi authentication" /></label>
            <label>Agent <select value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
              <option value="lead">Lead (workspace chung)</option>
              <option value="peer">Peer (source module)</option>
            </select></label>
            {role === "peer" && <label>Module <select required value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
              <option value="">Chọn module</option>
              {snapshot.modules.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select></label>}
            <label>Prompt <textarea required rows={5} maxLength={20000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Yêu cầu dành cho Agent..." /></label>
            <button className="primary" type="submit">Tạo Task</button>
          </form>
        </article>
        <article className="panel">
          <h2>Workspace & Modules</h2>
          <p className="muted">Đường dẫn đọc từ config local, không nhập trực tiếp trên UI.</p>
          <div className="module"><strong>Lead Workspace</strong><span>Được cấu hình trong workspace.local.json</span></div>
          {snapshot.modules.map((m) => <div className="module" key={m.id}>
            <strong>{m.label}</strong><code>{m.path}</code>
          </div>)}
        </article>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>Tasks & Sessions</h2><button onClick={() => void refresh()}>Làm mới</button></div>
        {snapshot.tasks.length === 0 ? <p className="muted">Chưa có Task.</p> :
          <div className="task-list">{snapshot.tasks.map((task) =>
            <div key={task.id} className={"task " + (selectedTask === task.id ? "selected" : "")}>
              <button className="task-title" onClick={() => setSelectedTask(task.id)}>
                <strong>{task.title}</strong><small>{task.role.toUpperCase()} {task.moduleId ? " · " + task.moduleId : ""}</small>
              </button>
              <span className={"status " + task.status}>{task.status}</span>
              {task.status === "queued" && <button onClick={() => void runAction("/tasks/" + task.id + "/run")}>Run</button>}
              {["running", "waiting_runtime_approval"].includes(task.status) &&
                <button onClick={() => void runAction("/tasks/" + task.id + "/interrupt")}>Interrupt</button>}
              {task.error && <small className="error-text">{task.error}</small>}
            </div>)}</div>}
      </section>
      <section className="columns">
        <article className="panel">
          <h2>Runtime Approvals</h2>
          {snapshot.approvals.filter((approval) => approval.status === "pending").length === 0 &&
            <p className="muted">Không có yêu cầu chờ duyệt.</p>}
          {snapshot.approvals.filter((approval) => approval.status === "pending").map((approval) =>
            <div className="approval" key={approval.id}>
              <strong>{approval.method}</strong>
              <pre>{JSON.stringify(approval.params, null, 2)}</pre>
              <div className="actions">
                <button onClick={() => void runAction("/approvals/" + approval.id + "/decision", { decision: "decline" })}>Từ chối</button>
                <button className="primary" onClick={() => void runAction("/approvals/" + approval.id + "/decision", { decision: "accept" })}>Cho phép lần này</button>
              </div>
            </div>)}
        </article>
        <article className="panel">
          <div className="panel-heading"><h2>Activity</h2><button onClick={() => setSelectedTask("")}>Tất cả</button></div>
          <div className="events">
            {visibleEvents.map((event) => <div key={event.id} className="event">
              <small>{new Date(event.createdAt).toLocaleTimeString()} · {event.taskId.slice(0, 8)}</small>
              <strong>{event.kind}</strong>
              <pre>{JSON.stringify(event.data, null, 2)}</pre>
            </div>)}
          </div>
        </article>
      </section>
      <footer>Foundation — chưa hỗ trợ Lead auto-dispatch, Business Approval hoặc Git worktree.</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
