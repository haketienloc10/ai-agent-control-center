import type { LeadCommand } from "@aacc/contracts";

/** Codex dynamic tools: route commands as structured host calls, not JSON inside agent prose. */
export const leadDynamicTools = [
  {
    name: "spawn_peer",
    description: "Mở một Codex Peer session mới trong module đã đăng ký và giao việc. Mọi kết quả gửi về Lead.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        moduleId: { type: "string", description: "Module ID trong danh sách MODULES" },
        message: { type: "string", description: "Nhiệm vụ đầy đủ cho Peer, có thể chứa JSON API contract" },
        label: { type: "string", description: "Nhãn hiển thị ngắn cho session" },
        model: { type: "string", description: "Model override khi spawn Peer; bỏ trống để dùng Peer default" },
        effort: { type: "string", description: "Reasoning effort override khi spawn Peer; bỏ trống để dùng Peer default" }
      },
      required: ["moduleId", "message"]
    }
  },
  {
    name: "send_peer",
    description: "Giao yêu cầu mới hoặc sửa/bổ sung công việc trong Peer Thread. Không dùng để hỏi tiến độ khi Peer đang chạy.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "Peer session ID từ PEER_SESSIONS" },
        message: { type: "string", description: "Instruction mới, thay đổi phạm vi hoặc sửa kết quả; KHÔNG hỏi tiến độ" }
      },
      required: ["sessionId", "message"]
    }
  },
  {
    name: "spawn_discovery",
    description: "Mở một Discovery session để khảo sát sơ bộ nhiều module theo yêu cầu cụ thể của Lead; chỉ một Discovery session mỗi conversation. Không điều tra sâu hoặc triển khai.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { message: { type: "string", description: "Câu hỏi/phạm vi cần khám phá sơ bộ và thông tin cần báo về Lead" } },
      required: ["message"]
    }
  },
  {
    name: "send_discovery",
    description: "Giao yêu cầu khảo sát sơ bộ bổ sung vào Discovery Thread đã có. Không dùng để hỏi tiến độ hoặc yêu cầu điều tra sâu.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "Discovery session ID từ DISCOVERY_SESSIONS" },
        message: { type: "string", description: "Nhiệm vụ khám phá sơ bộ mới, không phải status poll" }
      },
      required: ["sessionId", "message"]
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
      message: nonempty(input.message, "message")
    };
  }
  if (tool === "spawn_discovery") {
    return { type: "spawn_discovery", message: nonempty(input.message, "message") };
  }
  if (tool === "send_discovery") {
    return {
      type: "send_discovery",
      sessionId: nonempty(input.sessionId, "sessionId", 100),
      message: nonempty(input.message, "message")
    };
  }
  if (tool === "finish") {
    if (Object.keys(input).length) throw new Error("finish không nhận tham số; báo cáo cuối là Codex finalText");
    return { type: "finish" };
  }
  throw new Error("Unknown Lead tool: " + String(tool));
}

