import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactDescriptor } from "@aacc/contracts";

const MAX_BYTES = 8 * 1024 * 1024;

/** Content-addressed in metadata, UUID-addressed on disk. No user-controlled path interpolation. */
export class ArtifactStore {
  private readonly root: string;
  private readonly index: string;
  private records: ArtifactDescriptor[];
  constructor(dataDir: string) {
    this.root = join(dataDir, "artifacts");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.index = join(this.root, "index.json");
    this.records = existsSync(this.index)
      ? JSON.parse(readFileSync(this.index, "utf8")) as ArtifactDescriptor[] : [];
  }

  list(workflowId?: string): ArtifactDescriptor[] {
    return this.records.filter((v) => !workflowId || v.workflowId === workflowId).slice().reverse();
  }
  get(id: string): { descriptor: ArtifactDescriptor; content: Buffer } {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid artifact ID");
    const descriptor = this.records.find((v) => v.id === id);
    if (!descriptor) throw new Error("Artifact not found");
    const content = readFileSync(join(this.root, id));
    if (createHash("sha256").update(content).digest("hex") !== descriptor.sha256) {
      throw new Error("Artifact hash mismatch");
    }
    return { descriptor, content };
  }

  add(input: Omit<ArtifactDescriptor, "id" | "bytes" | "sha256" | "createdAt">, content: string | Buffer) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    if (buffer.length > MAX_BYTES) throw new Error("Artifact exceeds 8 MiB");
    const id = randomUUID();
    const descriptor: ArtifactDescriptor = {
      ...input, id, bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      createdAt: new Date().toISOString()
    };
    const path = join(this.root, id);
    writeFileSync(path, buffer, { flag: "wx", mode: 0o600 });
    const tmp = this.index + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify([...this.records, descriptor], null, 2), { mode: 0o600 });
      renameSync(tmp, this.index);
      this.records.push(descriptor);
    } catch (error) { throw error; }
    return descriptor;
  }
}
