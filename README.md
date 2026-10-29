# AI Agent Control Center

Dashboard **cá nhân, chạy trên máy local** để thay thế việc quản lý nhiều terminal Codex. Mục tiêu là giữ nguyên mô hình làm việc hiện có: **Lead Agent trong workspace chung → giao việc cho Peer ở các source module bên ngoài → nhận kết quả → Lead review / yêu cầu sửa → người dùng quyết định**.

> Trạng thái: P1 **Lead-controlled dispatch** trên nhánh tính năng; chưa phải production, cần kiểm tra với Codex CLI đã đăng nhập trên máy thực.

## Bắt đầu

Yêu cầu: Node.js >= 22, npm và Codex CLI đã cài, đăng nhập hợp lệ qua `codex login`.

```bash
npm install
cp config/workspace.example.json config/workspace.local.json
# Sửa lead.cwd và modules[].path thành các đường dẫn tuyệt đối có thật trên máy
npm run dev:api
# Trong terminal khác:
npm run dev:web
```

Mở http://localhost:5173; Backend mặc định http://127.0.0.1:4317. Tại Dashboard, chọn **Tạo & chạy Workflow** để Lead tự lập kế hoạch → Backend dispatch Peer → Lead review/rework → người dùng duyệt. Chức năng Task thủ công vẫn còn. Hệ thống tạo Codex thread ở `cwd` đã cấu hình, stream event lên UI và lưu trạng thái trong `.data/`.

Nếu chưa cài/đăng nhập Codex, API vẫn có thể khởi chạy nhưng **Run sẽ lỗi có thể quan sát được**. App chỉ dành cho localhost; không expose cổng trực tiếp ra Internet.

## Định hướng kỹ thuật

- `docs/GOALS.md`: mục tiêu, phạm vi, thành công và giới hạn.
- `docs/ARCHITECTURE.md`: module boundaries, data flow, lifecycle và security.
- `docs/ROADMAP.md`: các giai đoạn thực hiện, acceptance criteria.
- `docs/WORKFLOW_P1.md`: hợp đồng JSON, luồng triển khai P1, API, giới hạn.
- `AGENTS.md`: quy tắc dành cho contributor/Agent.
- `apps/api`: Backend, WorkflowEngine, Task Store, SessionManager và Codex JSON-RPC adapter.
- `apps/web`: Dashboard tối thiểu đọc dữ liệu và SSE, gửi lệnh Run/Interrupt/Approval.
- `packages/contracts`: kiểu dữ liệu dùng chung.

## Kiểm tra

```bash
npm run typecheck
npm test
curl http://127.0.0.1:4317/api/health
```

Các lệnh trên là **cách kiểm chứng**, không phải kết quả kiểm thử đã được xác nhận trong repo.

Tài liệu giao thức: https://developers.openai.com/codex/app-server

## P1: Lead → Peer → Review

- POST `/api/workflows` với `{ "title": "...", "request": "..." }`: tự chạy Lead lập kế hoạch.
- Lead trả `LeadPlan` JSON: `summary`, `tasks[]` có `id`, `moduleId`, `dependsOn`, `instructions`.
- Backend validation module/dependency DAG, chạy tối đa 2 Peer cùng lúc và chỉ **1 Peer/module**.
- Peer trả `PeerResult` JSON gồm `summary`, `changedFiles`, `tests`, `risks`. Backend bổ sung `PeerEvidence`: Git status trước/sau, Git diff preview, kiểm tra artifact path và command execution events.
- Lead review từng batch, chọn `accept` / `rework`; tối đa 2 lần làm lại/Peer.
- Khi tất cả Peer được chấp nhận, workflow dừng tại `waiting_business_approval`; người dùng quyết định tại Dashboard.
- POST `/api/workflows/:id/decision` với `{ "decision": "approve" }` hoặc `reject`.

**Lưu ý:** P1 cho phép ghi trực tiếp vào source module ngoài repo. Sao lưu/commit code của bạn trước khi chạy, và dùng module riêng hoặc worktree thủ công nếu cần cách ly. Worktree tự động, xác minh test độc lập và resume an toàn nằm ở P2. P1 không tự merge.
