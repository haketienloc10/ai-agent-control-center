import assert from "node:assert/strict";
import { test } from "node:test";
import { modelCatalog } from "./model-catalog.js";
import type { CodexClient } from "./codex-client.js";

test("model/list catalog uses available Codex models, supported efforts and pagination", async () => {
  let initialized = false;
  const calls: Record<string, unknown>[] = [];
  const fake = {
    async start() { initialized = true; },
    async request<T>(_method: string, params: Record<string, unknown>): Promise<T> {
      assert.equal(_method, "model/list");
      calls.push(params);
      if (!params.cursor) return {
        data: [
          { model: "model-a", displayName: "Model A", defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "high", description: "deep" }
            ] },
          { model: "hidden", hidden: true, supportedReasoningEfforts: [] }
        ],
        nextCursor: "next"
      } as T;
      return {
        data: [{ id: "model-b", supportedReasoningEfforts: ["medium", "xhigh"] }],
        nextCursor: null
      } as T;
    }
  } as Pick<CodexClient, "start" | "request">;
  const models = await modelCatalog(fake);
  assert.ok(initialized);
  assert.deepEqual(models, [
    { id: "model-a", displayName: "Model A", defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "high"] },
    { id: "model-b", displayName: "model-b", supportedReasoningEfforts: ["medium", "xhigh"] }
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, "next");
  assert.equal(calls[0].includeHidden, false);
});

test("Malformed model/list is surfaced as an error, never silently invents available models", async () => {
  const fake = {
    async start() {},
    async request<T>(): Promise<T> { return { invalid: true } as T; }
  } as Pick<CodexClient, "start" | "request">;
  await assert.rejects(modelCatalog(fake), /invalid data/);
});
