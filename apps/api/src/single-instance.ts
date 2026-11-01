import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Prevent two local servers from independently dispatching the same persisted Workflow. */
export class SingleInstanceLock {
  private readonly path: string;
  private fd?: number;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, "server.lock");
    this.acquire();
  }

  private acquire() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.fd = openSync(this.path, "wx", 0o600);
        writeFileSync(this.fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const raw = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
        let pid: number | undefined;
        try { pid = (JSON.parse(raw) as { pid?: number }).pid; } catch { /* malformed stale lock */ }
        if (pid && Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); throw new Error("AI Agent Control Center already running (PID " + pid + ")"); }
          catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
          }
        }
        // Stale lock after a crash. Another process could race; only retry once.
        unlinkSync(this.path);
      }
    }
    throw new Error("Cannot acquire exclusive backend lock");
  }

  release() {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
    try {
      const contents = JSON.parse(readFileSync(this.path, "utf8")) as { pid?: number };
      if (contents.pid === process.pid) unlinkSync(this.path);
    } catch { /* already removed */ }
  }
}
