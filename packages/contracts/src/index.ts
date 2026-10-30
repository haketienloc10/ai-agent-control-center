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
export interface ActivityEntry {
  id: string;
  taskId: string;
  type: "message" | "command" | "file" | "tool" | "workflow" | "status" | "error";
  title: string;
  detail: string;
  status: "info" | "running" | "completed" | "failed";
  source: string;
  itemId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface AcceptanceCriterion {
  id: string;
  description: string;
  verification: string;
}
export interface IntegrationCheck {
  criterionId: string;
  status: "passed" | "failed" | "unverified";
  evidence: string;
}
export interface IntegrationReview {
  summary: string;
  verdict: "pass" | "rework" | "manual_verification";
  checks: IntegrationCheck[];
  rework: Array<{ taskId: string; feedback: string }>;
}
export interface LeadPlan {
  summary: string;
  acceptanceCriteria: AcceptanceCriterion[];
  tasks: Array<{
    id: string; title: string; moduleId: string;
    instructions: string; dependsOn: string[];
  }>;
}
export interface PeerResult {
  summary: string; changedFiles: string[];
  tests: Array<{ command?: string; status: "passed" | "failed" | "not_run"; details?: string }>;
  risks: string[];
}
export interface PeerEvidence {
  git: {
    supported: boolean;
    statusBefore: string;
    statusAfter: string;
    diffStat: string;
    diffPreview: string;
    truncated: boolean;
  };
  files: Array<{
    path: string;
    exists: boolean;
    insideWorkspace: boolean;
    contentPreview?: string;
    truncated?: boolean;
    previewNote?: string;
  }>;
  commands: Array<{ command: string; exitCode?: number }>;
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
  attempts: PeerAttempt[]; result?: PeerResult; evidence?: PeerEvidence; feedback?: string;
}
export type WorkflowStatus =
  | "planning" | "executing" | "reviewing" | "integration_reviewing"
  | "waiting_manual_verification" | "waiting_business_approval"
  | "completed" | "rejected" | "failed" | "interrupted";
export interface WorkflowRun {
  id: string; title: string; request: string; status: WorkflowStatus;
  plan?: LeadPlan; peers: PeerWork[]; leadTaskIds: string[];
  reviewCount: number; integrationReviewCount?: number;
  finalReview?: IntegrationReview; manualVerifiedCriterionIds?: string[];
  maxReworks: number; error?: string;
  createdAt: string; updatedAt: string;
}
export interface Snapshot {
  tasks: Task[]; approvals: RuntimeApproval[]; events: ActivityEvent[];
  modules: ModuleConfig[]; workflows: WorkflowRun[]; activities: ActivityEntry[];
}
