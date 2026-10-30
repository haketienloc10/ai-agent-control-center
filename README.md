# AI Agent Control Center

Dashboard **cá nhân, chạy trên máy local** để thay thế việc quản lý nhiều terminal Codex. Mục tiêu là giữ nguyên mô hình làm việc hiện có: **Lead Agent trong workspace chung → giao việc cho Peer ở các source module bên ngoài → nhận kết quả → Lead review / yêu cầu sửa → người dùng quyết định**.

> Trạng thái: **foundation / skeleton**. Đã có lớp giao tiếp Codex app-server, Task/Session/Approval API và UI kiểm chứng cơ bản; **chưa** có vòng lặp Lead tự tạo kế hoạch, dispatch nhiều Peer và tự review end-to-end. Không coi bản này là hệ thống production.

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

Mở http://localhost:5173; Backend mặc định http://127.0.0.1:4317. Với bản skeleton, hãy tạo Task cho Lead hoặc Peer rồi bấm **Run**. Hệ thống tạo Codex thread ở `cwd` đã cấu hình, stream event lên UI và lưu trạng thái trong `.data/`.

Nếu chưa cài/đăng nhập Codex, API vẫn có thể khởi chạy nhưng **Run sẽ lỗi có thể quan sát được**. App chỉ dành cho localhost; không expose cổng trực tiếp ra Internet.

## Định hướng kỹ thuật

- `docs/GOALS.md`: mục tiêu, phạm vi, thành công và giới hạn.
- `docs/ARCHITECTURE.md`: module boundaries, data flow, lifecycle và security.
- `docs/ROADMAP.md`: các giai đoạn thực hiện, acceptance criteria.
- `AGENTS.md`: quy tắc dành cho contributor/Agent.
- `apps/api`: Backend, Task store, Session manager và Codex JSON-RPC adapter.
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
