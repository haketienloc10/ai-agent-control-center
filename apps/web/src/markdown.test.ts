import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "@aacc/contracts";
import { MarkdownContent } from "./components/MarkdownContent.js";
import { ConversationFeed, MessageBody } from "./components/ConversationFeed.js";

function render(source: string): string {
  return renderToStaticMarkup(createElement(MarkdownContent, { content: source }));
}

test("Codex Markdown renders heading, bold, lists, GFM table and fenced code block", () => {
  const source = [
    "## Kết quả kiểm thử", "",
    "- **API:** 4/4 tests passed",
    "- **Web:** build đạt", "",
    "| Kiểm tra | Kết quả |", "| --- | --- |",
    "| GET | 200 |", "",
    "\`\`\`bash", "npm run build", "\`\`\`"
  ].join("\n");
  const html = render(source);
  assert.match(html, /<h2[^>]*>Kết quả kiểm thử<\/h2>/);
  assert.match(html, /<strong>API:<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>200<\/td>/);
  assert.match(html, /<pre>/);
  assert.match(html, /npm run build/);
});

test("Links are safe, remote Markdown images do not fetch and raw HTML cannot execute", () => {
  const source = [
    "[Hướng dẫn](https://example.com/docs)",
    "[Không an toàn](javascript:alert(1))",
    "![Ảnh](https://tracker.example/collect?token=secret)",
    '<script>alert("danger")</script>',
    '<img src="https://tracker.example/other" onerror="alert(1)">'
  ].join("\n\n");
  const html = render(source);
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /<script[\s>]/i);
  assert.doesNotMatch(html, /<img[\s>]/i);
  assert.match(html, /Hình ảnh: Ảnh/);
});

test("Long messages are collapsed by CSS but full Markdown source remains rendered", () => {
  const trailing = "**Kết thúc báo cáo**";
  const source = "## Tổng kết\n\n" + "Nội dung kiểm thử đầy đủ. ".repeat(40) +
    "\n\n" + trailing;
  assert.ok(source.length > 720);
  const html = renderToStaticMarkup(createElement(MessageBody, { text: source }));
  assert.match(html, /class="message-body is-collapsed"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Xem toàn bộ/);
  assert.match(html, /<h2[^>]*>Tổng kết<\/h2>/);
  assert.match(html, /<strong>Kết thúc báo cáo<\/strong>/);
  assert.equal(source.includes(trailing), true, "The input source is never shortened");
});

test("Short messages show rendered Markdown without expansion control", () => {
  const html = renderToStaticMarkup(createElement(MessageBody, {
    text: "Đã **hoàn thành**."
  }));
  assert.match(html, /<strong>hoàn thành<\/strong>/);
  assert.doesNotMatch(html, /Xem toàn bộ/);
  assert.doesNotMatch(html, /is-collapsed/);
});

test("Peer routing details are rendered as Markdown, while remaining opt-in", () => {
  const at = "2026-11-05T14:00:00Z";
  const messages: Message[] = [
    { id: "a", conversationId: "todo", from: "peer", to: "lead", peerSessionId: "web",
      text: "### Peer Web\n\n- **Build đạt**\n\n\`npm run build\`", createdAt: at }
  ];
  const base = { messages, sessions: [{
    id: "web", role: "peer" as const, label: "Todo Web", moduleId: "web",
    conversationId: "todo", status: "idle" as const, createdAt: at, updatedAt: at
  }], conversationId: "todo", onRoutingChange: () => {} };
  const normal = renderToStaticMarkup(createElement(ConversationFeed, {
    ...base, showRouting: false
  }));
  assert.doesNotMatch(normal, /Build đạt/);
  const expandedFeed = renderToStaticMarkup(createElement(ConversationFeed, {
    ...base, showRouting: true
  }));
  assert.match(expandedFeed, /<h3[^>]*>Peer Web<\/h3>/);
  assert.match(expandedFeed, /<strong>Build đạt<\/strong>/);
  assert.match(expandedFeed, /<code>npm run build<\/code>/);
});
