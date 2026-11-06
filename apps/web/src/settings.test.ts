import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppSettings } from "@aacc/contracts";
import { AgentSettingsModal } from "./AgentSettingsModal.js";

test("Model & Effort modal has independent Discovery settings and preserves selections", () => {
  const settings: AppSettings = {
    lead: { model: "lead-model" },
    discovery: { model: "discovery-model", effort: "high" },
    peer: { effort: "medium" }
  };
  const html = renderToStaticMarkup(createElement(AgentSettingsModal, {
    initial: settings, onClose: () => {}, onSaved: async () => {}
  }));
  assert.match(html, /Discovery Agent/);
  assert.match(html, /id="discovery-model"/);
  assert.match(html, /id="discovery-effort"/);
  assert.match(html, /id="discovery-model"[^>]*value="discovery-model"/);
  assert.match(html, /id="discovery-effort"[^>]*value="high"/);
  assert.match(html, /id="lead-model"[^>]*value="lead-model"/);
  assert.match(html, /id="peer-effort"[^>]*value="medium"/);
  assert.match(html, /Lưu Settings/);
});

test("Model & Effort modal opens older snapshots that lack Discovery values", () => {
  const initial = { lead: {}, peer: {} } as AppSettings;
  const html = renderToStaticMarkup(createElement(AgentSettingsModal, {
    initial, onClose: () => {}, onSaved: async () => {}
  }));
  assert.match(html, /id="discovery-model"/);
  assert.match(html, /id="discovery-effort"/);
  assert.match(html, /Discovery Agent/);
});
