import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Data } from "./coordination-state.js";

/** Một snapshot SQLite lưu nguyên tử messages, sessions, deliveries và callId. */
export class CoordinationRepository {
  private readonly db: DatabaseSync;
  private state: Data;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "coordination.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL);");
    const row = this.db.prepare("SELECT body FROM snapshot WHERE id = 1").get() as { body: string } | undefined;
    this.state = row ? JSON.parse(row.body) as Data
      : { conversations: [], sessions: [], messages: [], deliveries: [], settings: { lead: {}, peer: {}, discovery: {} } };
  }

  /** Chỉ dùng nội bộ để đọc; mutation phải đi qua mutate(). */
  read(): Data { return this.state; }
  snapshot(): Data { return structuredClone(this.state); }

  private commit(candidate: Data): void {
    this.db.prepare("INSERT INTO snapshot(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(JSON.stringify(candidate));
    this.state = candidate;
  }

  recover(run: (data: Data) => boolean): void {
    const candidate = this.snapshot();
    if (run(candidate)) this.commit(candidate);
  }

  mutate<T>(run: (data: Data) => T): T {
    const candidate = this.snapshot();
    const result = run(candidate);
    this.commit(candidate);
    return result;
  }

  close(): void { this.db.close(); }
}
