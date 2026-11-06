import type { LeadCommand } from "@aacc/contracts";

/** Codex dynamic tools: route commands as structured host calls, not JSON inside agent prose. */
const contextRefField = {
  type: "array", maxItems: 8, uniqueItems: true,
  items: { type: "string" },
  description: "Message IDs từ NEW_EVENTS hoặc turn trước của Lead; App đính kèm nguyên văn các nguồn được chọn, trừ yêu cầu gốc và nguồn worker đã có"
};
const expectedResultField = {
  type: "string", description: "Kết quả và bằng chứng cụ thể cần báo lại Lead; tiêu chí kiểm chứng cho phạm vi này"
};
const taskBriefField = {
  type: "object", additionalProperties: false,
  properties: {
    goal: { type: "string" },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    verified: { type: "array", items: {
      type: "object", additionalProperties: false,
      properties: { finding: { type: "string" },
        evidenceRefs: { type: "array", minItems: 1, items: { type: "string" } } },
      required: ["finding", "evidenceRefs"] } },
    preliminary: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
    nextDecision: { type: "string" }
  },
  required: ["goal", "acceptanceCriteria", "verified", "preliminary", "unknowns", "nextDecision"]
};
export const leadDynamicTools = [
  {
    name: "assign_module",
    description: "Giao việc cho Peer của một module. Mỗi module có đúng một Peer: lần giao đầu App tạo Peer, các lần sau dùng lại Thread của Peer đó. Peer chỉ sửa module của mình; mọi kết quả gửi về Lead. Không dùng để hỏi tiến độ.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        moduleId: { type: "string", description: "Module ID trong danh sách MODULES" },
        message: { type: "string", description: "Chỉ phần việc mới của module này: phạm vi, ràng buộc, điều cần làm. Không tóm tắt lại yêu cầu gốc, Task Brief, quyết định hay báo cáo trước; App đã đính kèm" },
        expectedResult: expectedResultField,
        contextRefs: contextRefField,
        model: { type: "string", description: "Model override khi App tạo Peer lần đầu; bỏ trống để dùng Peer default" },
        effort: { type: "string", description: "Reasoning effort override khi App tạo Peer lần đầu; bỏ trống để dùng Peer default" }
      },
      required: ["moduleId", "message", "expectedResult"]
    }
  },
  {
    name: "record_decision",
    description: "Ghi quyết định của Lead về điều nhiều module cùng phụ thuộc (interface/contract, port, định dạng dữ liệu, thứ tự). Ghi lại cùng topic sẽ thay quyết định cũ. App tự đính kèm quyết định hiện hành cho Peer của các module trong affects ở lần assign_module tiếp theo.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        topic: { type: "string", description: "Tên ngắn, ổn định của chủ đề, ví dụ api-contract" },
        decision: { type: "string", description: "Nội dung quyết định đủ cụ thể để các Peer triển khai khớp nhau" },
        rationale: { type: "string", description: "Lý do và đánh đổi" },
        affects: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" },
          description: "Module ID phải tuân theo quyết định" },
        evidenceRefs: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string" },
          description: "Message IDs làm căn cứ cho quyết định" }
      },
      required: ["topic", "decision", "rationale", "affects"]
    }
  },
  {
    name: "spawn_discovery",
    description: "Mở một Discovery session để khảo sát sơ bộ nhiều module theo yêu cầu cụ thể của Lead; chỉ một Discovery session mỗi conversation. Không điều tra sâu hoặc triển khai.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        message: { type: "string", description: "Câu hỏi/phạm vi cần khám phá sơ bộ; không tóm tắt lại yêu cầu gốc vì App đã đính kèm" },
        expectedResult: expectedResultField,
        contextRefs: contextRefField
      },
      required: ["message", "expectedResult"]
    }
  },
  {
    name: "send_discovery",
    description: "Giao yêu cầu khảo sát sơ bộ bổ sung vào Discovery Thread đã có. Không dùng để hỏi tiến độ hoặc yêu cầu điều tra sâu.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "Discovery session ID từ DISCOVERY_SESSIONS" },
        message: { type: "string", description: "Nhiệm vụ khám phá sơ bộ mới, không lặp lại điều Discovery đã nhận; không phải status poll" },
        expectedResult: expectedResultField,
        contextRefs: contextRefField
      },
      required: ["sessionId", "message", "expectedResult"]
    }
  },
  {
    name: "update_task_brief",
    description: "Lead cập nhật hiểu biết hiện tại: mục tiêu, tiêu chí hoàn thành, phát hiện kèm evidenceRefs, nhận định sơ bộ, điểm chưa rõ và quyết định tiếp theo.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { brief: taskBriefField }, required: ["brief"]
    }
  },
  {
    name: "finish",
    description: "Đánh dấu toàn bộ task hoàn thành. Không truyền báo cáo vào tool; sau khi finish() thành công, trả lời người dùng bằng Codex finalText thông thường.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {}
    }
  }
];

function nonempty(value: unknown, name: string, limit = 20000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(name + " cần chuỗi hợp lệ, tối đa " + limit + " ký tự");
  }
  return value.trim();
}
function refList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8 || value.some(item =>
    typeof item !== "string" || !item.trim() || item.length > 100) ||
    new Set(value).size !== value.length) {
    throw new Error("contextRefs cần danh sách tối đa 8 message IDs, không trùng");
  }
  return value;
}
function briefFromTool(value: unknown): import("@aacc/contracts").TaskBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("brief phải là object");
  const input = value as Record<string, unknown>;
  const strings = (name: string): string[] => {
    const items = input[name];
    if (!Array.isArray(items) || items.length > 20) throw new Error(name + " phải là mảng tối đa 20 phần tử");
    return items.map(item => nonempty(item, name, 2000));
  };
  if (!Array.isArray(input.verified) || input.verified.length > 20) throw new Error("verified phải là mảng");
  const verified = input.verified.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("verified entry không hợp lệ");
    const record = item as Record<string, unknown>;
    const evidenceRefs = refList(record.evidenceRefs);
    if (!evidenceRefs.length) throw new Error("verified cần evidenceRefs");
    return { finding: nonempty(record.finding, "finding", 2000), evidenceRefs };
  });
  return {
    goal: nonempty(input.goal, "goal", 5000),
    acceptanceCriteria: strings("acceptanceCriteria"),
    verified,
    preliminary: strings("preliminary"),
    unknowns: strings("unknowns"),
    nextDecision: nonempty(input.nextDecision, "nextDecision", 3000)
  };
}
export function commandFromTool(tool: unknown, args: unknown): LeadCommand {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments phải là object");
  }
  const input = args as Record<string, unknown>;
  if (tool === "assign_module") {
    return {
      type: "assign_module",
      moduleId: nonempty(input.moduleId, "moduleId", 100),
      message: nonempty(input.message, "message"),
      expectedResult: nonempty(input.expectedResult, "expectedResult", 4000),
      contextRefs: refList(input.contextRefs),
      ...(typeof input.model === "string" && input.model.trim()
        ? { model: nonempty(input.model, "model", 128) } : {}),
      ...(typeof input.effort === "string" && input.effort.trim()
        ? { effort: nonempty(input.effort, "effort", 32) } : {})
    };
  }
  if (tool === "record_decision") {
    const affects = input.affects;
    if (!Array.isArray(affects) || !affects.length || affects.length > 20 ||
      new Set(affects).size !== affects.length) {
      throw new Error("affects cần danh sách module ID không rỗng, không trùng");
    }
    return {
      type: "record_decision",
      topic: nonempty(input.topic, "topic", 200),
      decision: nonempty(input.decision, "decision", 8000),
      rationale: nonempty(input.rationale, "rationale", 4000),
      affects: affects.map(item => nonempty(item, "affects", 100)),
      evidenceRefs: refList(input.evidenceRefs)
    };
  }
  if (tool === "spawn_discovery") {
    return {
      type: "spawn_discovery", message: nonempty(input.message, "message"),
      expectedResult: nonempty(input.expectedResult, "expectedResult", 4000),
      contextRefs: refList(input.contextRefs)
    };
  }
  if (tool === "send_discovery") {
    return {
      type: "send_discovery",
      sessionId: nonempty(input.sessionId, "sessionId", 100),
      message: nonempty(input.message, "message"),
      expectedResult: nonempty(input.expectedResult, "expectedResult", 4000),
      contextRefs: refList(input.contextRefs)
    };
  }
  if (tool === "update_task_brief") {
    return { type: "update_task_brief", brief: briefFromTool(input.brief) };
  }
  if (tool === "finish") {
    if (Object.keys(input).length) throw new Error("finish không nhận tham số; báo cáo cuối là Codex finalText");
    return { type: "finish" };
  }
  throw new Error("Unknown Lead tool: " + String(tool));
}

