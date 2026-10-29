export type AgentRole = "lead" | "peer";
export type TaskStatus =
  | "queued" | "starting" | "running" | "waiting_runtime_approval"
  | "completed" | "failed" | "interrupted";
export interface ModuleConfig { id: string; label: string; path: string }
export interface WorkspaceConfig {
  lead: { cwd: string; instructions: string };
  modules: ModuleConfig[];
}
export interface Task {
  id: string; title: string; prompt: string; role: AgentRole;
  moduleId?: string; workflowId?: string; output?: string;
  status: TaskStatus; threadId?: string; turnId?: string; error?: string;
  createdAt: string; updatedAt: string;
}
export interface RuntimeApproval {
  id: string; taskId: string; requestId: string | number;
  method: string; params: Record<string, unknown>;
  status: "pending" | "accepted" | "declined" | "expired"; createdAt: string;
}
export interface ActivityEvent {
  id: string; taskId: string; kind: string; data: unknown; createdAt: string;
}
export interface LeadPlan {
  summary: string;
  tasks: Array<{
    id: string; title: string; moduleId: string;
    instructions: string; dependsOn: string[];
  }>;
}
export interface PeerResult {
  summary: string; changedFiles: string[];
  tests: Array<{ command: string; status: "passed" | "failed" | "not_run"; details?: string }>;
  risks: string[];
}
export interface LeadReview {
  summary: string;
  reviews: Array<{ taskId: string; decision: "accept" | "rework"; feedback: string }>;
}
export interface PeerAttempt {
  taskId: string; iteration: number; result?: PeerResult; feedback?: string;
}
export interface PeerWork {
  id: string; moduleId: string; title: string; instructions: string; dependsOn: string[];
  status: "pending" | "running" | "review_pending" | "accepted" | "rework" | "failed";
  attempts: PeerAttempt[]; result?: PeerResult; feedback?: string;
}
export type WorkflowStatus =
  | "planning" | "executing" | "reviewing" | "waiting_business_approval"
  | "completed" | "rejected" | "failed" | "interrupted";
export interface WorkflowRun {
  id: string; title: string; request: string; status: WorkflowStatus;
  plan?: LeadPlan; peers: PeerWork[]; leadTaskIds: string[];
  reviewCount: number; maxReworks: number; error?: string;
  createdAt: string; updatedAt: string;
}
export interface Snapshot {
  tasks: Task[]; approvals: RuntimeApproval[]; events: ActivityEvent[];
  modules: ModuleConfig[]; workflows: WorkflowRun[];
}
