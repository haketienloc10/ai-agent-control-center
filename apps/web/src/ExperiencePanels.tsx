import { useEffect, useState } from "react";
import type { JournalPage, NotificationEntry, RuntimeMetrics,
  SessionHistoryItem, SessionHistoryPage, WorkflowRun } from "@aacc/contracts";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch("/api" + path, { cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json() as Promise<T>;
}
const localTime = (iso: string) => new Date(iso).toLocaleString("vi-VN");
const byteSize = (n: number) => (n / (1024 * 1024)).toFixed(1) + " MiB";

export function ObservabilityPanel({ notifications, onAcknowledge, onInspectTask,
  onInspectWorkflow }: {
  notifications: NotificationEntry[];
  onAcknowledge: (id: string) => void;
  onInspectTask: (id: string) => void;
  onInspectWorkflow: (id: string) => void;
}) {
  const [metrics, setMetrics] = useState<RuntimeMetrics | null>(null);
  const [error, setError] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(true);
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const data = await getJson<RuntimeMetrics>("/metrics");
        if (mounted) { setMetrics(data); setError(""); }
      } catch (cause) { if (mounted) setError(String(cause)); }
    };
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 8000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);
  const visible = notifications.filter(n => !unreadOnly || !n.readAt).slice(0, 15);
  return <section className="panel" aria-label="Tài nguyên và thông báo">
    <div className="panel-heading">
      <div><h2>Quan sát hệ thống</h2>
        <p className="muted">Số liệu của tiến trình Backend; không phải CPU/RAM của từng Codex Agent.</p>
      </div>
      {metrics && <small>Cập nhật: {new Date(metrics.observedAt).toLocaleTimeString("vi-VN")}</small>}
    </div>
    {error && <p role="status" className="error-text">Không cập nhật được metrics: {error}</p>}
    {metrics ? <div className="p3-metric-grid">
      <div><span>Agent tasks đang chạy</span><strong>{metrics.tasks.active}</strong>
        <small>{metrics.tasks.queued} trong hàng đợi</small></div>
      <div><span>Workflow đang xử lý</span><strong>{metrics.workflows.active}</strong>
        <small>{metrics.workflows.waitingHuman} đang chờ bạn</small></div>
      <div><span>RAM Backend (RSS)</span><strong>{byteSize(metrics.backend.rssBytes)}</strong>
        <small>Heap: {byteSize(metrics.backend.heapUsedBytes)}</small></div>
      <div><span>CPU time Backend</span>
        <strong>{(metrics.backend.cpuUserSeconds + metrics.backend.cpuSystemSeconds).toFixed(1)} s</strong>
        <small>Uptime: {Math.floor(metrics.backend.uptimeSeconds / 60)} phút</small></div>
    </div> : <p className="muted">Đang đọc số liệu Backend…</p>}
    <div className="panel-heading p3-alert-heading">
      <h3>Thông báo ({notifications.filter(n => !n.readAt).length} chưa đọc)</h3>
      <label className="p3-checkbox"><input type="checkbox" checked={unreadOnly}
        onChange={e => setUnreadOnly(e.target.checked)}/> Chưa đọc</label>
    </div>
    {visible.length ? <div className="p3-alert-list">
      {visible.map(n => <div key={n.id} className={"p3-alert " + (!n.readAt ? "p3-alert-unread" : "")}>
        <div><strong>{n.title}</strong><small>{localTime(n.createdAt)}</small>
          <p>{n.message}</p></div>
        <div className="p3-alert-actions">
          <button type="button" onClick={() => n.scope === "task"
            ? onInspectTask(n.targetId) : onInspectWorkflow(n.targetId)}>Xem</button>
          {!n.readAt && <button type="button" onClick={() => onAcknowledge(n.id)}>Đã đọc</button>}
        </div>
      </div>)}
    </div> : <p className="muted">Không có thông báo phù hợp.</p>}
  </section>;
}

export function SessionHistory({ workflows, onInspectTask }: {
  workflows: WorkflowRun[]; onInspectTask: (id: string) => void;
}) {
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<SessionHistoryPage>({ items: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const query = () => {
    const params = new URLSearchParams({ limit: "20" });
    if (role) params.set("role", role);
    if (status) params.set("status", status);
    if (workflowId) params.set("workflowId", workflowId);
    return params;
  };
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    const load = async () => {
      try {
        const data = await getJson<SessionHistoryPage>("/sessions?" + query());
        if (mounted) { setPage(data); setError(""); }
      } catch (cause) { if (mounted) setError(String(cause)); }
      finally { if (mounted) setLoading(false); }
    };
    void load();
    return () => { mounted = false; };
  }, [role, status, workflowId, revision]);
  const older = async () => {
    if (!page.nextCursor || loading) return;
    setLoading(true);
    try {
      const params = query();
      params.set("cursor", page.nextCursor);
      const result = await getJson<SessionHistoryPage>("/sessions?" + params);
      setPage(previous => ({ items: [...previous.items, ...result.items],
        nextCursor: result.nextCursor }));
      setError("");
    } catch (cause) { setError(String(cause)); }
    finally { setLoading(false); }
  };
  return <section className="panel" aria-label="Lịch sử Codex sessions">
    <div className="panel-heading"><div>
      <h2>Lịch sử Agent / Codex Sessions</h2>
      <p className="muted">Đọc trạng thái đã lưu qua restart. Thời lượng tính từ lúc Task bắt đầu đến khi kết thúc.</p>
    </div><button type="button" onClick={() => setRevision(n => n + 1)}>Làm mới</button></div>
    <div className="p3-filter-grid">
      <label>Role <select value={role} onChange={e => setRole(e.target.value)}>
        <option value="">Tất cả</option><option value="lead">Lead</option>
        <option value="peer">Peer</option><option value="reviewer">Final Reviewer</option>
      </select></label>
      <label>Status <select value={status} onChange={e => setStatus(e.target.value)}>
        <option value="">Tất cả</option>
        {["queued","starting","running","completed","failed","interrupted","cancelled","waiting_runtime_approval"]
          .map(s => <option key={s} value={s}>{s}</option>)}
      </select></label>
      <label>Workflow <select value={workflowId} onChange={e => setWorkflowId(e.target.value)}>
        <option value="">Tất cả</option>
        {workflows.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}
      </select></label>
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="p3-session-list">
      {page.items.map((s: SessionHistoryItem) => <button type="button" key={s.id}
        className="p3-session" onClick={() => onInspectTask(s.id)}>
        <span><strong>{s.title}</strong>
          <small>{s.role.toUpperCase()}{s.moduleId ? " · " + s.moduleId : ""}</small>
          <small>Thread: {s.threadId?.slice(0, 18) ?? "Chưa khởi tạo"} · {localTime(s.createdAt)}</small></span>
        <span className="p3-session-meta"><span className={"status " + s.status}>{s.status}</span>
          {s.durationMs !== undefined && <small>{Math.round(s.durationMs / 1000)} giây</small>}</span>
      </button>)}
    </div>
    {!loading && !page.items.length && <p className="muted">Không có session phù hợp.</p>}
    {page.nextCursor && <button type="button" onClick={() => void older()} disabled={loading}>
      {loading ? "Đang tải…" : "Tải session cũ hơn"}</button>}
  </section>;
}

export function JournalExplorer() {
  const [taskId, setTaskId] = useState("");
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<JournalPage>({ items: [] });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const buildQuery = () => {
    const params = new URLSearchParams({ limit: "30" });
    if (taskId.trim()) params.set("taskId", taskId.trim());
    if (kind) params.set("kind", kind);
    if (search.trim()) params.set("search", search.trim());
    return params;
  };
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void getJson<JournalPage>("/journal/history?" + buildQuery()).then(result => {
      if (mounted) { setPage(result); setError(""); }
    }).catch(cause => { if (mounted) setError(String(cause)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [revision]);
  const older = async () => {
    if (page.nextCursor === undefined || loading) return;
    setLoading(true);
    try {
      const params = buildQuery();
      params.set("before", String(page.nextCursor));
      const next = await getJson<JournalPage>("/journal/history?" + params);
      setPage(previous => ({ items: [...previous.items, ...next.items], nextCursor: next.nextCursor }));
    } catch (cause) { setError(String(cause)); }
    finally { setLoading(false); }
  };
  return <section className="panel" aria-label="Event journal">
    <div className="panel-heading"><div><h2>Event Journal · Lịch sử bền vững</h2>
      <p className="muted">Truy vấn SQLite theo cursor, không giới hạn ở các sự kiện đang hiển thị trên timeline.</p>
    </div></div>
    <form className="p3-journal-filter" onSubmit={e => { e.preventDefault(); setRevision(n => n + 1); }}>
      <label>Kind prefix <select value={kind} onChange={e => setKind(e.target.value)}>
        <option value="">Tất cả</option>
        <option value="workflow/">Workflow</option>
        <option value="task/">Task</option>
        <option value="turn/">Turn</option>
        <option value="item/">Tool / Item</option>
        <option value="runtime/">Runtime</option>
      </select></label>
      <label>Task ID <input value={taskId} maxLength={128}
        onChange={e => setTaskId(e.target.value)} placeholder="UUID hoặc workflow:UUID"/></label>
      <label>Tìm trong event data <input value={search} maxLength={120}
        onChange={e => setSearch(e.target.value)} placeholder="Từ khóa"/></label>
      <button className="primary" type="submit">Lọc</button>
    </form>
    {error && <p role="alert" className="error-text">{error}</p>}
    <div className="p3-journal-list">{page.items.map(entry => <details key={entry.id}>
      <summary><time>{localTime(entry.createdAt)}</time> · #{entry.seq} · {entry.kind}</summary>
      <small>{entry.taskId}</small><pre>{JSON.stringify(entry.data, null, 2)}</pre>
    </details>)}</div>
    {!loading && !page.items.length && <p className="muted">Không có event phù hợp.</p>}
    {page.nextCursor !== undefined && <button type="button" disabled={loading}
      onClick={() => void older()}>{loading ? "Đang tải…" : "Tải event cũ hơn"}</button>}
  </section>;
}
