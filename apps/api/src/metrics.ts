import type { RuntimeMetrics, Task, WorkflowRun } from "@aacc/contracts";

/** Host process telemetry, never attributed to individual Codex workers. */
export function runtimeMetrics(
  tasks: Task[], workflows: WorkflowRun[], unread: number,
  runtime: { memory: { rss: number; heapUsed: number };
    cpu: { user: number; system: number }; uptime: number } = {
    memory: process.memoryUsage(), cpu: process.cpuUsage(), uptime: process.uptime()
  }
): RuntimeMetrics {
  const active = (status: string) =>
    ["starting", "running", "waiting_runtime_approval"].includes(status);
  return {
    observedAt: new Date().toISOString(),
    backend: {
      uptimeSeconds: Math.round(runtime.uptime),
      rssBytes: runtime.memory.rss,
      heapUsedBytes: runtime.memory.heapUsed,
      cpuUserSeconds: runtime.cpu.user / 1e6,
      cpuSystemSeconds: runtime.cpu.system / 1e6
    },
    tasks: {
      total: tasks.length, active: tasks.filter(t => active(t.status)).length,
      queued: tasks.filter(t => t.status === "queued").length,
      failed: tasks.filter(t => t.status === "failed").length,
      interrupted: tasks.filter(t => t.status === "interrupted").length
    },
    workflows: {
      total: workflows.length,
      active: workflows.filter(w => ["planning", "executing", "reviewing", "integration_reviewing"]
        .includes(w.status)).length,
      waitingHuman: workflows.filter(w =>
        ["waiting_business_approval", "waiting_manual_verification"].includes(w.status)).length,
      failed: workflows.filter(w => ["failed", "blocked", "interrupted"].includes(w.status)).length
    },
    alerts: { unread }
  };
}
