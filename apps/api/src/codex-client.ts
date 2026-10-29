import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}
interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// Chỉ xử lý transport JSON-RPC; không biết Task, Module hay nghiệp vụ của Lead.
export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private readonly command = "codex", private readonly args = ["app-server", "--listen", "stdio://"]) {
    super();
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.connect().catch((error) => { this.ready = undefined; throw error; });
    return this.ready;
  }

  private async connect(): Promise<void> {
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child = child;
    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => {
      try { this.handle(JSON.parse(line) as RpcMessage); }
      catch { this.emit("protocolError", "Invalid JSONL from codex app-server"); }
    });
    child.stderr.on("data", () => this.emit("diagnostic", "Codex stderr received; inspect local terminal"));
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code) => {
      this.failAll(new Error("Codex app-server exited: " + code));
      this.child = undefined;
      this.ready = undefined;
      this.emit("exit", code);
    });
    await this.request("initialize", {
      clientInfo: { name: "ai_agent_control_center", title: "AI Agent Control Center", version: "0.1.0" }
    });
    this.notify("initialized", {});
  }

  private failAll(error: Error) {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timeout);
      item.reject(error);
      this.pending.delete(id);
    }
  }

  private handle(message: RpcMessage) {
    if (message.id !== undefined && typeof message.method === "string") {
      this.emit("serverRequest", message);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") this.emit("notification", message);
  }

  private send(message: RpcMessage) {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not available");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex RPC timeout: " + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: Record<string, unknown>) { this.send({ method, params }); }

  respond(id: string | number, result: Record<string, unknown>) { this.send({ id, result }); }

  rejectServerRequest(id: string | number, message = "Unsupported server request") {
    this.send({ id, error: { code: -32601, message } });
  }

  stop() { this.child?.kill(); }
}
