import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRole } from "@aacc/contracts";

export const defaultInstructionsDir = fileURLToPath(new URL("../../../instructions", import.meta.url));

/** Role rules live in `<dir>/<role>.md`, read each turn. A missing or empty file means the role has no rules. */
export function roleInstructions(dir: string, role: AgentRole): string | undefined {
  try {
    return readFileSync(join(dir, role + ".md"), "utf8").trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
