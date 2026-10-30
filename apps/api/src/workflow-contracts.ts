import type { IntegrationReview, LeadPlan, LeadReview, PeerResult, WorkspaceConfig } from "@aacc/contracts";

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as Record<string, unknown>;
};
const nonempty = (value: unknown, field: string, max = 12000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(field + " không hợp lệ");
  return value.trim();
};
const array = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(field + " phải là array");
  return value;
};

// Cho phép LLM trả JSON trong code fence, nhưng từ chối prose lẫn ngoài fence.
export function parseAgentJson(output: string): unknown {
  const stripped = output.trim();
  const match = /^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i.exec(stripped);
  try { return JSON.parse(match ? match[1] : stripped) as unknown; }
  catch { throw new Error("Agent output phải là JSON hợp lệ, không có văn bản ngoài JSON"); }
}

export function validateLeadPlan(value: unknown, config: WorkspaceConfig): LeadPlan {
  const data = object(value);
  const tasks = array(data.tasks, "tasks");
  if (tasks.length < 1 || tasks.length > 20) throw new Error("LeadPlan yêu cầu 1-20 Peer tasks");
  const ids = new Set<string>();
  const normalized = tasks.map((raw) => {
    const t = object(raw);
    const id = nonempty(t.id, "task.id", 48);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new Error("task.id trùng hoặc không hợp lệ: " + id);
    ids.add(id);
    const moduleId = nonempty(t.moduleId, "task.moduleId", 100);
    if (!config.modules.some((m) => m.id === moduleId)) throw new Error("Module chưa đăng ký: " + moduleId);
    const dependsOn = array(t.dependsOn, "task.dependsOn").map((v) => nonempty(v, "dependency", 48));
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error("Duplicate dependencies: " + id);
    return {
      id, moduleId, dependsOn,
      title: nonempty(t.title, "task.title", 200),
      instructions: nonempty(t.instructions, "task.instructions")
    };
  });
  const tasksById = new Map(normalized.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("LeadPlan contains dependency cycle at " + id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of tasksById.get(id)!.dependsOn) {
      if (!tasksById.has(dep) || dep === id) throw new Error("Invalid dependency " + dep + " for " + id);
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of normalized) visit(task.id);
  const criteria = array(data.acceptanceCriteria, "acceptanceCriteria");
  if (criteria.length < 1 || criteria.length > 12) throw new Error("LeadPlan yêu cầu 1-12 acceptanceCriteria");
  const seenCriteria = new Set<string>();
  const acceptanceCriteria = criteria.map((raw) => {
    const criterion = object(raw);
    const id = nonempty(criterion.id, "criterion.id", 48);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || seenCriteria.has(id)) throw new Error("criterion.id trùng hoặc không hợp lệ: " + id);
    seenCriteria.add(id);
    return { id, description: nonempty(criterion.description, "criterion.description", 600),
      verification: nonempty(criterion.verification, "criterion.verification", 1000) };
  });
  return { summary: nonempty(data.summary, "plan.summary"), tasks: normalized, acceptanceCriteria };
}

export function validatePeerResult(value: unknown): PeerResult {
  const data = object(value);
  const changedFiles = array(data.changedFiles, "changedFiles").map((v) => nonempty(v, "changedFiles item", 500));
  const risks = array(data.risks, "risks").map((v) => nonempty(v, "risk", 2000));
  const tests = array(data.tests, "tests").map((raw) => {
    const t = object(raw);
    if (t.status !== "passed" && t.status !== "failed" && t.status !== "not_run") {
      throw new Error("Invalid test status");
    }
    // An unexecuted test does not have a command; never require or invent one.
    const command = typeof t.command === "string" && t.command.trim() ? nonempty(t.command, "test.command", 1000) : undefined;
    if (t.status !== "not_run" && !command) {
      throw new Error("test.command bắt buộc khi test.status là passed hoặc failed");
    }
    if (t.command !== null && t.command !== undefined && typeof t.command !== "string") {
      throw new Error("test.command không hợp lệ");
    }
    const details = typeof t.details === "string" && t.details.trim()
      ? nonempty(t.details, "test.details", 3000) : undefined;
    if (t.details !== null && t.details !== undefined && typeof t.details !== "string") {
      throw new Error("test.details không hợp lệ");
    }
    return {
      ...(command ? { command } : {}),
      status: t.status as PeerResult["tests"][number]["status"],
      ...(details ? { details } : {})
    };
  });
  return { summary: nonempty(data.summary, "result.summary"), changedFiles, tests, risks };
}

export function validateLeadReview(value: unknown, batchIds: string[]): LeadReview {
  const data = object(value);
  const reviews = array(data.reviews, "reviews");
  if (reviews.length !== batchIds.length) {
    const found = reviews.map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return (entry as Record<string, unknown>).taskId;
      }
      return undefined;
    });
    throw new Error("LeadReview phải quyết định mỗi Peer trong batch; expected taskId: " +
      JSON.stringify(batchIds) + "; received: " + JSON.stringify(found));
  }
  const seen = new Set<string>();
  const normalized = reviews.map((raw) => {
    const r = object(raw);
    const taskId = nonempty(r.taskId, "review.taskId", 48);
    if (!batchIds.includes(taskId) || seen.has(taskId)) throw new Error("Unexpected review taskId " + taskId);
    seen.add(taskId);
    if (r.decision !== "accept" && r.decision !== "rework") throw new Error("Invalid review decision " + taskId);
    return { taskId, decision: r.decision as "accept" | "rework", feedback: nonempty(r.feedback, "review.feedback", 4000) };
  });
  return { summary: nonempty(data.summary, "review.summary"), reviews: normalized };
}

export function validateIntegrationReview(value: unknown, criterionIds: string[], peerIds: string[]): IntegrationReview {
  const data = object(value);
  if (data.verdict !== "pass" && data.verdict !== "rework" && data.verdict !== "manual_verification") {
    throw new Error("IntegrationReview.verdict phải là pass, rework hoặc manual_verification");
  }
  const checksRaw = array(data.checks, "integration.checks");
  if (checksRaw.length !== criterionIds.length) throw new Error("IntegrationReview phải kiểm tra đúng mọi acceptance criterion");
  const seen = new Set<string>();
  const checks = checksRaw.map((raw) => {
    const check = object(raw);
    const criterionId = nonempty(check.criterionId, "check.criterionId", 48);
    if (!criterionIds.includes(criterionId) || seen.has(criterionId)) {
      throw new Error("IntegrationReview check thiếu/thừa/trùng criterionId: " + criterionId);
    }
    seen.add(criterionId);
    if (check.status !== "passed" && check.status !== "failed" && check.status !== "unverified") {
      throw new Error("IntegrationReview check.status không hợp lệ");
    }
    return {
      criterionId, status: check.status as "passed" | "failed" | "unverified",
      evidence: nonempty(check.evidence, "check.evidence", 3000)
    };
  });
  const reworkRaw = array(data.rework, "integration.rework");
  if (reworkRaw.length > peerIds.length) throw new Error("IntegrationReview quá nhiều Peer rework");
  const reworked = new Set<string>();
  const rework = reworkRaw.map((raw) => {
    const item = object(raw);
    const taskId = nonempty(item.taskId, "rework.taskId", 48);
    if (!peerIds.includes(taskId) || reworked.has(taskId)) {
      throw new Error("IntegrationReview rework taskId không hợp lệ: " + taskId);
    }
    reworked.add(taskId);
    return { taskId, feedback: nonempty(item.feedback, "rework.feedback", 4000) };
  });
  const hasFailed = checks.some((c) => c.status === "failed");
  const hasUnverified = checks.some((c) => c.status === "unverified");
  if (data.verdict === "pass" && (hasFailed || hasUnverified || rework.length)) {
    throw new Error("IntegrationReview không được pass khi còn failed/unverified hoặc rework");
  }
  if (data.verdict === "rework" && (!hasFailed || !rework.length)) {
    throw new Error("IntegrationReview rework cần ít nhất một failed criterion và Peer feedback");
  }
  if (data.verdict === "manual_verification" && (hasFailed || !hasUnverified || rework.length)) {
    throw new Error("IntegrationReview manual_verification chỉ dùng khi còn unverified, không có failed/rework");
  }
  return { summary: nonempty(data.summary, "integration.summary", 5000),
    verdict: data.verdict, checks, rework };
}
