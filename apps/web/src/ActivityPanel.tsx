import { useMemo, useState } from "react";
import type { ActivityEntry, ActivityEvent, Task, WorkflowRun, ModuleConfig } from "@aacc/contracts";
import { activitySource, matchesActivityFilter, readableDetail, shortDetail, type ActivityFilter } from "./activity-view.js";

interface Props {
  activities: ActivityEntry[];
  events: ActivityEvent[];
  tasks: Task[];
  workflows: WorkflowRun[];
  modules: ModuleConfig[];
  selectedTask: string;
  onSelectTask: (id: string) => void;
}

const FILTERS: Array<{ key: ActivityFilter; label: string }> = [
  { key: "all", label: "Tất cả" },
  { key: "lead", label: "Lead" },
  { key: "peer", label: "Peer" },
  { key: "workflow", label: "Workflow" }
];

const STATUS: Record<ActivityEntry["status"], string> = {
  info: "Thông tin",
  running: "Đang thực hiện",
  completed: "Hoàn thành",
  failed: "Lỗi"
};

export function ActivityPanel({ activities, events, tasks, workflows, selectedTask, onSelectTask }: Props) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [technical, setTechnical] = useState(false);

  const selectedName = tasks.find((task) => task.id === selectedTask)?.title;
  const visible = useMemo(() => activities
    .filter((entry) => matchesActivityFilter(entry, tasks, filter, selectedTask))
    .slice(-100).reverse(), [activities, tasks, filter, selectedTask]);

  const raw = useMemo(() => events.filter((event) =>
    !selectedTask || event.taskId === selectedTask).slice(-40).reverse(), [events, selectedTask]);

  return <section className="panel activity-panel" aria-label="Nhật ký hoạt động">
    <div className="panel-heading activity-heading">
      <div>
        <h2>Nhật ký hoạt động</h2>
        <p className="muted">Theo dõi Agent đang làm gì, kết quả và lỗi theo thời gian thực.</p>
      </div>
      <button type="button" onClick={() => setTechnical((value) => !value)}
        aria-pressed={technical} className={technical ? "active-control" : ""}>
        {technical ? "Trở lại dễ đọc" : "Xem log kỹ thuật"}
      </button>
    </div>
    {selectedTask && <div className="activity-selection">
      Đang xem Task: <strong>{selectedName || selectedTask.slice(0, 8)}</strong>
      <button type="button" onClick={() => onSelectTask("")}>Bỏ lọc Task</button>
    </div>}

    {technical ? <div className="activity-raw">
      <p className="muted">Chế độ debug · hiển thị sự kiện gần đây; các mẩu text streaming đã được gom, không lưu từng token.</p>
      {raw.length === 0 ? <p className="muted">Chưa có sự kiện kỹ thuật.</p> :
        raw.map((event) => <details className="raw-entry" key={event.id}>
          <summary><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString("vi-VN")}</time> · {event.kind}</summary>
          <pre>{JSON.stringify(event.data, null, 2)}</pre>
        </details>)}
    </div> : <>
      <div className="activity-filters" role="group" aria-label="Lọc hoạt động">
        {FILTERS.map(({ key, label }) => <button type="button" key={key}
          className={filter === key ? "active-control" : ""} aria-pressed={filter === key}
          onClick={() => setFilter(key)}>{label}</button>)}
      </div>
      {visible.length === 0 ? <div className="activity-empty">
        <strong>Chưa có hoạt động phù hợp</strong>
        <p>Hãy tạo một Workflow hoặc chọn bộ lọc khác để xem tiến độ.</p>
      </div> : <ol className="activity-timeline" aria-live="polite" aria-relevant="additions text">
        {visible.map((entry) => {
          const description = readableDetail(entry);
          const collapsed = shortDetail(description);
          return <li className={"activity-entry activity-" + entry.status} key={entry.id}>
            <span className="activity-dot" aria-hidden="true" />
            <div className="activity-entry-body">
              <div className="activity-meta">
                <span className="activity-source">{activitySource(entry, tasks, workflows)}</span>
                <time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleTimeString("vi-VN")}</time>
              </div>
              <div className="activity-title-line">
                <strong>{entry.title}</strong>
                <span className={"activity-state activity-state-" + entry.status}>{STATUS[entry.status]}</span>
              </div>
              {description && <p className="activity-description">{collapsed}</p>}
              {description.length > collapsed.length && <details className="activity-expanded">
                <summary>Xem đầy đủ</summary>
                <pre>{entry.detail}</pre>
              </details>}
            </div>
          </li>;
        })}
      </ol>}
    </>}
  </section>;
}
