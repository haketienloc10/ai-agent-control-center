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
        label: { type: "string", description: "Nhãn hiển thị ngắn cho session" }
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
    name: "finish",
    description: "Lead tự quyết định công việc hoàn tất; không có quality approval gate.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        summary: { type: "string", description: "Báo cáo kết quả cho người dùng" }
      }
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
      ...(typeof input.label === "string" ? { label: input.label.slice(0, 100) } : {})
    };
  }
  if (tool === "send_peer") {
    return {
      type: "send_peer",
      sessionId: nonempty(input.sessionId, "sessionId", 100),
      message: nonempty(input.message, "message")
    };
  }
  if (tool === "finish") {
    return { type: "finish", ...(typeof input.summary === "string"
      ? { summary: input.summary.slice(0, 20000) } : {}) };
  }
  throw new Error("Unknown Lead tool: " + String(tool));
}

