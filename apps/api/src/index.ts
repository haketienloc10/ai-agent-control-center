import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { loadWorkspaceConfig } from "./config.js";
import { CoordinationStore } from "./coordination-store.js";
import { CodexClient } from "./codex-client.js";
import { modelCatalog } from "./model-catalog.js";
import { CodexAgentRuntime } from "./codex-runtime.js";
import { Coordinator, shouldDiscover } from "./coordinator.js";
import { SingleInstanceLock } from "./single-instance.js";

const config = loadWorkspaceConfig();
const dataDir = process.env.APP_DATA_DIR ?? fileURLToPath(new URL("../../../.data", import.meta.url));
const lock = new SingleInstanceLock(dataDir);
const store = new CoordinationStore(dataDir);
const codex = new CodexClient();
const coordinator = new Coordinator(config, store, new CodexAgentRuntime(codex));
void coordinator;
const port = Number(process.env.PORT ?? "4317");

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 25000) throw new Error("Request body too large");
  }
  try { return JSON.parse(body); }
  catch { throw new Error("Invalid JSON body"); }
}
const server = createServer(async (req, res) => {
  try {
    // Local-only MVP. UI runs via Vite proxy; reject cross-origin browser writes.
    const origin = req.headers.origin;
    if (origin && !["http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) {
      json(res, 403, { error: "Origin denied" }); return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, { ok: true, mode: "lead-peer", modules: config.modules.length }); return;
    }
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      json(res, 200, { modules: config.modules, ...store.snapshot() }); return;
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      try { json(res, 200, { models: await modelCatalog(codex) }); }
      catch (error) {
        json(res, 503, { error: "Không tải được model/list từ Codex: " +
          (error instanceof Error ? error.message : String(error)) });
      }
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/settings") {
      json(res, 200, store.updateSettings(await readJson(req))); return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        Connection: "keep-alive", "X-Accel-Buffering": "no"
      });
      res.write("data: " + JSON.stringify({ kind: "connected" }) + "\n\n");
      const send = () => res.write("data: " + JSON.stringify({ kind: "changed" }) + "\n\n");
      store.on("change", send);
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20000);
      req.on("close", () => { store.off("change", send); clearInterval(heartbeat); });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/conversations") {
      const data = await readJson(req) as { text?: string; title?: string } | null;
      const request = data?.text ?? "";
      json(res, 201, store.createConversation(request, data?.title,
        shouldDiscover(config, request))); return;
    }
    const messageRoute = /^\/api\/conversations\/([0-9a-f-]+)\/messages$/.exec(url.pathname);
    if (req.method === "POST" && messageRoute) {
      const data = await readJson(req) as { text?: string } | null;
      json(res, 201, store.postUser(messageRoute[1], data?.text ?? "")); return;
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, /not found/i.test(message) ? 404 : 400, { error: message });
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log("AI Agent Communication Center: http://127.0.0.1:" + port);
});
function shutdown() {
  server.close();
  codex.stop();
  store.close();
  lock.release();
}
process.once("SIGTERM", () => { shutdown(); process.exit(0); });
process.once("SIGINT", () => { shutdown(); process.exit(0); });
