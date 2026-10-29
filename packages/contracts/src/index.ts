export type AgentRole = "lead" | "peer";
export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_runtime_approval"
  | "completed"
  | "failed"
  | "interrupted";

export interface ModuleConfig {
  id: string;
  label: string;
  path: string;
}

export interface WorkspaceConfig {
  lead: { cwd: string; instructions: string };
  modules: ModuleConfig[];
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  role: AgentRole;
  moduleId?: string;
  status: TaskStatus;
  threadId?: string;
  turnId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeApproval {
  id: string;
  taskId: string;
  requestId: string | number;
  method: string;
  params: Record<string, unknown>;
  status: "pending" | "accepted" | "declined" | "expired";
  createdAt: string;
}

export interface ActivityEvent {
  id: string;
  taskId: string;
  kind: string;
  data: unknown;
  createdAt: string;
}

export interface Snapshot {
  tasks: Task[];
  approvals: RuntimeApproval[];
  events: ActivityEvent[];
  modules: ModuleConfig[];
}
