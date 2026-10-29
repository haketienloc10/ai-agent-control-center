# Hướng dẫn cho Agent / contributor

- Viết Markdown và tài liệu hướng người đọc bằng tiếng Việt; giữ nguyên identifiers, config keys và logs.
- Giữ phân tách `apps/web` (presentation), `apps/api` (application), `packages/contracts` (shared types).
- Không để UI gọi trực tiếp Codex CLI, không truyền đường dẫn `cwd` từ request.
- Lead chạy trong workspace chung, Peer trong source module đăng ký; các source module nằm ngoài repository này.
- Không gắn logic workflow vào Codex JSON-RPC adapter. App-server không phải Orchestrator.
- Không tự approve các yêu cầu runtime; không bật danger-full-access.
- Không giả định `turn/completed` là success nếu `turn.status` không phải `completed`.
- Sửa code phải kèm test/verification phù hợp, phân biệt đã chạy và chỉ đề xuất.
- Không commit `config/workspace.local.json`, `.data/`, credentials.
- Ưu tiên giữ API hợp đồng ổn định, xử lý lỗi và lifecycle rõ ràng, tránh abstractions không có nhu cầu.
- Đọc `docs/GOALS.md`, `docs/ARCHITECTURE.md` trước khi thay đổi mô hình điều phối.

- P1: LeadPlan, PeerResult, LeadReview trả JSON hợp lệ; không tự động accept khi parse/validation lỗi.
- Dependency chỉ mở khóa khi Lead accept. Rework tối đa 2 lần, không tự retry vô hạn.
- Peer làm việc trong `moduleId` thuộc registry, tối đa một writer mỗi module ở P1; chưa có Git worktree isolation.
- Business Approval chỉ là quyết định của người dùng trên Workflow, khác Runtime Approval trong Codex.
