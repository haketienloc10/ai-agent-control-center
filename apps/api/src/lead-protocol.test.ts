import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLeadResponse } from "./lead-protocol.js";

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
