import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { loadWorkspaceConfig } from "./config.js";
import { createTask } from "./domain.js";
import { TaskStore } from "./store.js";
import { CodexClient } from "./codex-client.js";
import { SessionManager } from "./session-manager.js";
import { WorktreeManager } from "./worktree-manager.js";
import { ArtifactStore } from "./artifacts.js";
import { P2Services } from "./p2-services.js";
import { RecoveryManager } from "./recovery.js";
import { SingleInstanceLock } from "./single-instance.js";
import { WorkflowEngine } from "./workflow-engine.js";

const config = loadWorkspaceConfig();
const dataDir = process.env.APP_DATA_DIR ?? fileURLToPath(new URL("../../../.data", import.meta.url));
const instanceLock = new SingleInstanceLock(dataDir);
const store = new TaskStore(dataDir);
const runtime = new CodexClient();
const worktrees = new WorktreeManager(config, dataDir);
const artifacts = new ArtifactStore(dataDir);
const p2 = new P2Services(config, worktrees, artifacts);
const manager = new SessionManager(config, store, runtime, 2, worktrees);
const workflows = new WorkflowEngine(config, store, manager, p2);
const recovery = new RecoveryManager(config, store, runtime, manager);
const port = Number(process.env.PORT ?? "4317");

function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
async function readJson(req: IncomingMessage) {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 25000) throw new Error("Request body too large");
  }
  return JSON.parse(body) as unknown;
}

const server = createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;
    if (origin && !["http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) {
      json(res, 403, { error: "Origin denied" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, { ok: true, mode: "local", configuredModules: config.modules.length });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      json(res, 200, {
        tasks: store.list(), events: store.events(), approvals: store.approvals(),
        modules: config.modules, workflows: store.workflows(), activities: store.activities(),
        artifacts: artifacts.list()
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/journal") {
      json(res, 200, store.journal(Number(url.searchParams.get("after") ?? "0"),
        Number(url.searchParams.get("limit") ?? "100")));
      return;
    }
    const artifactMatch = /^\/api\/artifacts\/([0-9a-f-]+)$/.exec(url.pathname);
    if (req.method === "GET" && artifactMatch) {
      const artifact = artifacts.get(artifactMatch[1]);
      res.writeHead(200, {
        "Content-Type": artifact.descriptor.kind === "patch"
          ? "text/x-diff; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"" + artifact.descriptor.id +
          (artifact.descriptor.kind === "patch" ? ".patch" : ".json") + "\"",
        "Cache-Control": "no-store"
      });
      res.end(artifact.content);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write("data: " + JSON.stringify({ kind: "connected" }) + "\n\n");
      const send = () => res.write("data: " + JSON.stringify({ kind: "changed" }) + "\n\n");
      store.on("change", send);
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20000);
      req.on("close", () => { store.off("change", send); clearInterval(heartbeat); });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/tasks") {
      const body = await readJson(req) as Record<string, unknown>;
      if (body.role === "reviewer") throw new Error("Final Reviewer is reserved for workflow quality gate");
      json(res, 201, store.add(createTask(body, config)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/workflows") {
      json(res, 202, workflows.create(await readJson(req)));
      return;
    }
    const reviewRetry = /^\/api\/workflows\/([^/]+)\/retry-review$/.exec(url.pathname);
    if (req.method === "POST" && reviewRetry) {
      json(res, 202, workflows.retryReview(reviewRetry[1]));
      return;
    }
    const integrationRetry = /^\/api\/workflows\/([^/]+)\/retry-integration$/.exec(url.pathname);
    if (req.method === "POST" && integrationRetry) {
      json(res, 202, workflows.retryIntegration(integrationRetry[1]));
      return;
    }
    const manualVerification = /^\/api\/workflows\/([^/]+)\/confirm-verification$/.exec(url.pathname);
    if (req.method === "POST" && manualVerification) {
      const body = await readJson(req) as Record<string, unknown>;
      if (!Array.isArray(body?.criterionIds) || !body.criterionIds.every((id) => typeof id === "string") ||
          (body.contractIds !== undefined && (!Array.isArray(body.contractIds) ||
            !body.contractIds.every((id) => typeof id === "string")))) {
        throw new Error("criterionIds và contractIds phải là danh sách IDs được xác minh thủ công");
      }
      json(res, 200, workflows.confirmManualVerification(manualVerification[1],
        body.criterionIds as string[], (body.contractIds ?? []) as string[]));
      return;
    }
    const workflowDecision = /^\/api\/workflows\/([^/]+)\/decision$/.exec(url.pathname);
    if (req.method === "POST" && workflowDecision) {
      const body = await readJson(req) as Record<string, unknown>;
      if (body?.decision !== "approve" && body?.decision !== "reject") throw new Error("Invalid business decision");
      json(res, 200, workflows.decide(workflowDecision[1], body.decision));
      return;
    }
    const exportPatch = /^\/api\/tasks\/([^/]+)\/export-patch$/.exec(url.pathname);
    if (req.method === "POST" && exportPatch) {
      const task = store.get(exportPatch[1]);
      if (!task) throw new Error("Task not found");
      json(res, 201, p2.exportManualPatch(task));
      return;
    }
    const reconcile = /^\/api\/tasks\/([^/]+)\/reconcile$/.exec(url.pathname);
    if (req.method === "POST" && reconcile) {
      json(res, 200, await recovery.reconcile(reconcile[1]));
      return;
    }
    const followup = /^\/api\/tasks\/([^/]+)\/continue$/.exec(url.pathname);
    if (req.method === "POST" && followup) {
      const body = await readJson(req) as Record<string, unknown>;
      json(res, 202, await recovery.continueTask(followup[1], body?.prompt));
      return;
    }
    const run = /^\/api\/tasks\/([^/]+)\/run$/.exec(url.pathname);
    if (req.method === "POST" && run) {
      json(res, 202, manager.start(run[1]));
      return;
    }
    const interrupt = /^\/api\/tasks\/([^/]+)\/interrupt$/.exec(url.pathname);
    if (req.method === "POST" && interrupt) {
      json(res, 202, await manager.interrupt(interrupt[1]));
      return;
    }
    const runtimeApproval = /^\/api\/approvals\/([^/]+)\/decision$/.exec(url.pathname);
    if (req.method === "POST" && runtimeApproval) {
      const body = await readJson(req) as Record<string, unknown>;
      if (body?.decision !== "accept" && body?.decision !== "decline") throw new Error("Invalid runtime decision");
      json(res, 200, manager.decide(runtimeApproval[1], body.decision));
      return;
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, ["Task not found", "Workflow not found"].includes(message) ? 404 : 400, { error: message });
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log("AI Agent Control Center API listening on http://127.0.0.1:" + port);
  void recovery.reconcileAll().catch((error: unknown) =>
    console.error("Startup reconciliation failed:", error));
});
process.on("SIGINT", () => { runtime.stop(); server.close(); store.close(); instanceLock.release(); });
process.on("SIGTERM", () => { runtime.stop(); server.close(); store.close(); instanceLock.release(); });
