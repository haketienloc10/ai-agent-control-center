import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { loadWorkspaceConfig } from "./config.js";
import { createTask } from "./domain.js";
import { TaskStore } from "./store.js";
import { CodexClient } from "./codex-client.js";
import { SessionManager } from "./session-manager.js";
import { WorkflowEngine } from "./workflow-engine.js";

const config = loadWorkspaceConfig();
const dataDir = process.env.APP_DATA_DIR ?? fileURLToPath(new URL("../../../.data", import.meta.url));
const store = new TaskStore(dataDir);
const runtime = new CodexClient();
const manager = new SessionManager(config, store, runtime);
const workflows = new WorkflowEngine(config, store, manager);
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
        modules: config.modules, workflows: store.workflows(), activities: store.activities()
      });
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
      json(res, 201, store.add(createTask(await readJson(req), config)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/workflows") {
      json(res, 202, workflows.create(await readJson(req)));
      return;
    }
    const workflowDecision = /^\/api\/workflows\/([^/]+)\/decision$/.exec(url.pathname);
    if (req.method === "POST" && workflowDecision) {
      const body = await readJson(req) as Record<string, unknown>;
      if (body?.decision !== "approve" && body?.decision !== "reject") throw new Error("Invalid business decision");
      json(res, 200, workflows.decide(workflowDecision[1], body.decision));
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
});
process.on("SIGINT", () => { runtime.stop(); server.close(); });
process.on("SIGTERM", () => { runtime.stop(); server.close(); });
