import { randomUUID } from "node:crypto";
import type { ActivityEntry, ActivityEvent } from "@aacc/contracts";

const MAX_TEXT = 14000;
const MAX_ENTRIES = 500;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const short = (value: string, n = 160) => value.length > n ? value.slice(0, n) + "…" : value;

export function projectActivity(entries: ActivityEntry[], event: ActivityEvent): boolean {
  const { taskId, kind, createdAt } = event;
  const data = record(event.data);
  const item = record(data.item);
  const itemId = string(data.itemId) || string(item.id) || undefined;

  function add(type: ActivityEntry["type"], title: string, detail = "", status: ActivityEntry["status"] = "info"): ActivityEntry {
    const entry: ActivityEntry = {
      id: randomUUID(), taskId, type, title, detail: short(detail, MAX_TEXT),
      status, createdAt, updatedAt: createdAt,
      ...(itemId ? { itemId } : {}), source: kind
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    return entry;
  }

  function previous(type: ActivityEntry["type"]) {
    return [...entries].reverse().find((a) => a.taskId === taskId && a.type === type &&
      (itemId ? a.itemId === itemId : a.status === "running"));
  }

  function update(entry: ActivityEntry, patch: Partial<ActivityEntry>) {
    Object.assign(entry, patch, { updatedAt: createdAt });
  }

  if (kind === "item/agentMessage/delta") {
    const delta = string(data.delta);
    if (!delta) return false;
    const existing = previous("message");
    if (existing && existing.status === "running") {
      update(existing, { detail: short(existing.detail + delta, MAX_TEXT) });
    } else {
      add("message", "Agent đang viết kết quả", delta, "running");
    }
    return true;
  }

  if (kind === "item/commandExecution/outputDelta") {
    // Command output chunks can be huge. Keep command metadata and final status, not raw output fragments.
    return false;
  }

  if (kind === "item/started") {
    switch (item.type) {
      case "agentMessage":
        if (!previous("message")) add("message", "Agent đang viết kết quả", "", "running");
        return true;
      case "commandExecution":
        add("command", "Đang chạy lệnh", short(string(item.command) || "Shell command", 300), "running");
        return true;
      case "fileChange":
        add("file", "Đang cập nhật tệp", "", "running");
        return true;
      case "webSearch":
        add("tool", "Đang tra cứu thông tin", "", "running");
        return true;
      default:
        return false;
    }
  }

  if (kind === "item/completed") {
    const type = string(item.type);
    if (type === "agentMessage") {
      const message = string(item.text);
      const existing = previous("message");
      if (existing) update(existing, { title: "Agent đã trả kết quả", status: "completed", detail: short(message || existing.detail, MAX_TEXT) });
      else add("message", "Agent đã trả kết quả", message, "completed");
      return true;
    }
    if (type === "commandExecution") {
      const exitCode = item.exitCode;
      const failed = typeof exitCode === "number" && exitCode !== 0;
      const detail = [string(item.command), typeof exitCode === "number" ? "Exit code: " + exitCode : ""].filter(Boolean).join("\n");
      const existing = previous("command");
      if (existing) update(existing, {
        title: failed ? "Lệnh thực thi thất bại" : "Đã chạy lệnh",
        detail: detail || existing.detail, status: failed ? "failed" : "completed"
      });
      else add("command", failed ? "Lệnh thực thi thất bại" : "Đã chạy lệnh", detail, failed ? "failed" : "completed");
      return true;
    }
    if (type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes.length : undefined;
      const existing = previous("file");
      const detail = changes !== undefined ? "Đã xử lý " + changes + " thay đổi tệp" : "Đã xử lý thay đổi tệp";
      if (existing) update(existing, { title: "Đã cập nhật tệp", detail, status: "completed" });
      else add("file", "Đã cập nhật tệp", detail, "completed");
      return true;
    }
    if (type === "webSearch") {
      const existing = previous("tool");
      if (existing) update(existing, { title: "Đã tra cứu thông tin", status: "completed" });
      else add("tool", "Đã tra cứu thông tin", "", "completed");
      return true;
    }
    return false;
  }

  if (kind === "turn/started") { add("status", "Agent bắt đầu xử lý", "", "running"); return true; }
  if (kind === "turn/completed") {
    const status = string(record(data.turn).status);
    add("status", status === "completed" ? "Agent đã hoàn thành lượt làm việc" :
      status === "interrupted" ? "Đã dừng Agent" : "Lượt làm việc kết thúc với lỗi",
      "", status === "completed" ? "completed" : status === "interrupted" ? "info" : "failed");
    return true;
  }
  if (kind === "runtime/error") {
    add("error", "Agent gặp lỗi", string(data.message) || "Không thể hoàn thành công việc", "failed");
    return true;
  }
  if (kind === "task/status") {
    const status = string(data.status);
    const labels: Record<string, string> = {
      starting: "Đang khởi tạo Agent", running: "Agent đang làm việc",
      waiting_runtime_approval: "Agent đang chờ cấp quyền",
      completed: "Task đã hoàn thành", failed: "Task gặp lỗi",
      interrupted: "Task đã dừng"
    };
    if (labels[status]) add("status", labels[status], string(data.error),
      status === "failed" ? "failed" : status === "completed" ? "completed" : "info");
    return !!labels[status];
  }

  if (kind === "workflow/planning") { add("workflow", "Lead đang lập kế hoạch", string(data.title), "running"); return true; }
  if (kind === "workflow/plan") {
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    add("workflow", "Lead đã lập kế hoạch", [string(data.summary), tasks.length + " công việc được phân chia"].filter(Boolean).join(" · "), "completed");
    return true;
  }
  if (kind === "workflow/dispatch") {
    const ids = Array.isArray(data.peerIds) ? data.peerIds : [];
    add("workflow", "Đã giao việc cho Peer", ids.length + " Peer bắt đầu thực hiện", "running");
    return true;
  }
  if (kind === "workflow/peer_result") {
    const result = record(data.result);
    add("workflow", "Peer đã gửi kết quả cho Lead", string(result.summary), "completed");
    return true;
  }
  if (kind === "workflow/review") {
    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    const accepted = reviews.filter((r) => record(r).decision === "accept").length;
    add("workflow", "Lead đã đánh giá kết quả", accepted + " chấp nhận · " + (reviews.length - accepted) + " cần sửa lại", "completed");
    return true;
  }
  if (kind === "workflow/integration_review_started") {
    add("workflow", "Lead đang kiểm tra tích hợp tổng thể", "Đối chiếu acceptance criteria và kết quả các module", "running");
    return true;
  }
  if (kind === "workflow/integration_review") {
    const verdict = string(data.verdict);
    const title = verdict === "pass" ? "Tích hợp tổng thể đã đạt" :
      verdict === "rework" ? "Tích hợp cần sửa lại" : "Cần xác minh thủ công";
    add("workflow", title, string(data.summary), verdict === "pass" ? "completed" : "info");
    return true;
  }
  if (kind === "workflow/integration_review_resumed") {
    add("workflow", "Đang thử lại Final Integration Review", "Giữ nguyên kết quả các Peer", "running");
    return true;
  }
  if (kind === "workflow/plan_validation_failed") {
    add("workflow", "Lead đang điều chỉnh kế hoạch", string(data.reason), "info");
    return true;
  }
  if (kind === "workflow/integration_validation_failed") {
    add("workflow", "Lead đang điều chỉnh báo cáo kiểm tra cuối", string(data.reason), "info");
    return true;
  }
  if (kind === "workflow/manual_verification_confirmed") {
    const ids = Array.isArray(data.criterionIds) ? data.criterionIds : [];
    add("workflow", "Bạn đã xác nhận kiểm tra thủ công", ids.length + " acceptance criteria", "completed");
    return true;
  }
  if (kind === "workflow/ready_for_approval") {
    add("workflow", "Đang chờ bạn duyệt kết quả", "Tất cả Peer đã được Lead chấp nhận", "running");
    return true;
  }
  if (kind === "workflow/business_approval") {
    const approved = data.decision === "approve";
    add("workflow", approved ? "Bạn đã duyệt kết quả" : "Bạn đã từ chối kết quả", "", approved ? "completed" : "failed");
    return true;
  }
  if (kind === "workflow/failed") {
    add("error", "Workflow thất bại", string(data.message), "failed");
    return true;
  }
  return false;
}
