import type { ActivityEntry, Task, WorkflowRun } from "@aacc/contracts";

export type ActivityFilter = "all" | "lead" | "peer" | "workflow";

export function activitySource(entry: ActivityEntry, tasks: Task[], workflows: WorkflowRun[]): string {
  if (entry.taskId.startsWith("workflow:")) {
    const workflow = workflows.find((wf) => wf.id === entry.taskId.slice("workflow:".length));
    return workflow ? "Workflow · " + workflow.title : "Workflow";
  }
  const task = tasks.find((t) => t.id === entry.taskId);
  if (!task) return "Agent";
  return task.role === "lead" ? "Lead · " + task.title : "Peer" + (task.moduleId ? " · " + task.moduleId : "") + " · " + task.title;
}

export function matchesActivityFilter(
  entry: ActivityEntry, tasks: Task[], filter: ActivityFilter, selectedTask: string
): boolean {
  if (selectedTask && entry.taskId !== selectedTask) return false;
  if (filter === "all") return true;
  if (filter === "workflow") return entry.taskId.startsWith("workflow:");
  if (entry.taskId.startsWith("workflow:")) return false;
  return tasks.find((t) => t.id === entry.taskId)?.role === filter;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function readableDetail(entry: ActivityEntry): string {
  const raw = entry.detail.trim();
  if (!raw) return "";
  if (entry.type !== "message") return raw;
  try {
    const parsed = asObject(JSON.parse(raw));
    if (!parsed) return raw;
    if (Array.isArray(parsed.tasks)) {
      const titles = parsed.tasks.map((v) => asObject(v)?.title).filter((v): v is string => typeof v === "string");
      return "Lead đề xuất " + parsed.tasks.length + " nhiệm vụ" + (titles.length ? ": " + titles.join(", ") : ".");
    }
    if (Array.isArray(parsed.reviews)) {
      const accepts = parsed.reviews.filter((r) => asObject(r)?.decision === "accept").length;
      return "Lead đã review " + parsed.reviews.length + " Peer: " + accepts + " đạt, " +
        (parsed.reviews.length - accepts) + " cần sửa.";
    }
    if (typeof parsed.summary === "string") {
      const files = Array.isArray(parsed.changedFiles) ? " · " + parsed.changedFiles.length + " tệp được báo cáo" : "";
      return parsed.summary + files;
    }
  } catch {
    if (entry.status === "running" && (raw.startsWith("{") || raw.startsWith("```"))) {
      return "Agent đang tổng hợp kết quả…";
    }
  }
  return raw;
}

export function shortDetail(detail: string, limit = 360): string {
  return detail.length > limit ? detail.slice(0, limit) + "…" : detail;
}
