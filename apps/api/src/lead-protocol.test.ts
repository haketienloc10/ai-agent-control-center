import assert from "node:assert/strict";
import { test } from "node:test";
import { LeadProtocolError, parseLeadResponse } from "./lead-protocol.js";

test("Lead may respond in normal prose without business schema rejection", () => {
  assert.deepEqual(parseLeadResponse("Tôi đang xem kết quả."), {
    reply: "Tôi đang xem kết quả.", commands: []
  });
});
test("Lead routing envelope accepts spawn, resume, finish and ignores invalid tool actions", () => {
  const response = [
    "```json",
    '{"reply":"Đang thực hiện","commands":[',
    '{"type":"spawn_peer","moduleId":"web","message":"Viết README"},',
    '{"type":"send_peer","sessionId":"s1","message":"Bổ sung"},',
    '{"type":"finish","summary":"Xong"},',
    '{"type":"unsafe_shell","command":"rm -rf /"}',
    ']}',
    "```"
  ].join("\n");
  const result = parseLeadResponse(response);
  assert.equal(result.reply, "Đang thực hiện");
  assert.deepEqual(result.commands.map(c => c.type),
    ["spawn_peer", "send_peer", "finish"]);
});

test("Lead may send JSON string encoded twice, Markdown fenced or surrounded by prose", () => {
  const payload = JSON.stringify({
    reply: "Backend đã xong, triển khai Web",
    commands: [{ type: "spawn_peer", moduleId: "web", message:
      'GET /api/todos returns {"todos":[]} and POST sends {"title":"Task"}' }]
  });
  assert.deepEqual(parseLeadResponse(JSON.stringify(payload)),
    parseLeadResponse(payload));
  assert.deepEqual(parseLeadResponse("Kết quả:\n```json\n" + payload + "\n```"),
    parseLeadResponse(payload));
  assert.deepEqual(parseLeadResponse(payload + "\nTiếp tục triển khai."),
    parseLeadResponse(payload));
});

test("Malformed routing JSON must not silently become a Lead reply", () => {
  const malformed = '{"reply":"Giao Peer Web","commands":[{"type":"spawn_peer",' +
    '"moduleId":"web","message":"GET returns {"todos":[]}"}]}';
  assert.throws(() => parseLeadResponse(malformed), LeadProtocolError);
  assert.throws(() => parseLeadResponse('{"commands":[{"type":"spawn_peer","message":"hi"}]}'),
    LeadProtocolError);
  assert.deepEqual(parseLeadResponse("Tôi đang phân tích yêu cầu và sẽ phản hồi."), {
    reply: "Tôi đang phân tích yêu cầu và sẽ phản hồi.", commands: []
  });
});
