import type { LeadCommand } from "@aacc/contracts";

/** Codex dynamic tools: route commands as structured host calls, not JSON inside agent prose. */
const contextRefField = {
  type: "array", maxItems: 8, uniqueItems: true,
  items: { type: "string" },
  description: "Message IDs trong RECENT_CONVERSATION; App đính kèm nguyên văn các nguồn được chọn"
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
    name: "spawn_peer",
    description: "Mở một Codex Peer session mới trong module đã đăng ký và giao việc. Mọi kết quả gửi về Lead.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        moduleId: { type: "string", description: "Module ID trong danh sách MODULES" },
        message: { type: "string", description: "Nhiệm vụ tự đầy đủ; không tham chiếu ngầm đến lịch sử Lead" },
        expectedResult: expectedResultField,
        contextRefs: contextRefField,
        label: { type: "string", description: "Nhãn hiển thị ngắn cho session" },
        model: { type: "string", description: "Model override khi spawn Peer; bỏ trống để dùng Peer default" },
        effort: { type: "string", description: "Reasoning effort override khi spawn Peer; bỏ trống để dùng Peer default" }
      },
      required: ["moduleId", "message", "expectedResult"]
    }
  },
  {
    name: "send_peer",
    description: "Giao yêu cầu mới hoặc sửa/bổ sung công việc trong Peer Thread. Không dùng để hỏi tiến độ khi Peer đang chạy.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "Peer session ID từ PEER_SESSIONS" },
        message: { type: "string", description: "Instruction mới, thay đổi phạm vi hoặc sửa kết quả; KHÔNG hỏi tiến độ" },
        expectedResult: expectedResultField,
        contextRefs: contextRefField
      },
      required: ["sessionId", "message", "expectedResult"]
    }
  },
  {
    name: "spawn_discovery",
    description: "Mở một Discovery session để khảo sát sơ bộ nhiều module theo yêu cầu cụ thể của Lead; chỉ một Discovery session mỗi conversation. Không điều tra sâu hoặc triển khai.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        message: { type: "string", description: "Câu hỏi/phạm vi cần khám phá sơ bộ" },
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
        message: { type: "string", description: "Nhiệm vụ khám phá sơ bộ mới, không phải status poll" },
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
  if (tool === "spawn_peer") {
    return {
      type: "spawn_peer",
      moduleId: nonempty(input.moduleId, "moduleId", 100),
      message: nonempty(input.message, "message"),
      expectedResult: nonempty(input.expectedResult, "expectedResult", 4000),
      contextRefs: refList(input.contextRefs),
      ...(typeof input.label === "string" ? { label: input.label.slice(0, 100) } : {}),
      ...(typeof input.model === "string" && input.model.trim()
        ? { model: nonempty(input.model, "model", 128) } : {}),
      ...(typeof input.effort === "string" && input.effort.trim()
        ? { effort: nonempty(input.effort, "effort", 32) } : {})
    };
  }
  if (tool === "send_peer") {
    return {
      type: "send_peer",
      sessionId: nonempty(input.sessionId, "sessionId", 100),
      message: nonempty(input.message, "message"),
      expectedResult: nonempty(input.expectedResult, "expectedResult", 4000),
      contextRefs: refList(input.contextRefs)
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

