# Roadmap

## P0 — Foundation (PR này)

- [x] Mô tả mục tiêu, architecture, ranh giới của Lead/Peer.
- [x] Monorepo npm workspaces và shared contracts.
- [x] Local API, Workspace Registry, Task Store, Event SSE.
- [x] Codex JSON-RPC stdio Adapter, Thread/Turn lifecycle.
- [x] UI tối thiểu: Task, Run, Interrupt, Events, runtime Approval.
- [ ] Kiểm thử tích hợp với Codex CLI trên máy người dùng (cần Codex đăng nhập và module thật).

**Nghiệm thu:** cấu hình đường dẫn, tạo và chạy một Task, nhìn thấy event và trạng thái cuối.

## P1 — Lead-controlled dispatch (nhánh PR)

- [x] `LeadPlan`/`PeerResult`/`LeadReview` schema và validation, DAG module allowlist.
- [x] Queue + dependency + giới hạn tổng 2 concurrent, mỗi module 1 Peer.
- [x] Handoff `PeerResult` có changedFiles/tests/risks kèm `PeerEvidence` (Git status/diff preview, command events, file path check) sang Lead review. Chưa có independent test verification.
- [x] Lead review → accept/rework với tối đa 2 reworks/Peer, Business Approval trên UI.
- [x] Mock executor + tests kiểm tra dependency/rework/concurrency/restart.
- [x] Final Integration Review + Acceptance Criteria; rework Peer/downstream và manual-verification gate.
- [x] Mock E2E tests cho integration mismatch, rework dependency, manual confirmation và giới hạn rework.
- [ ] Live integration E2E với Codex app-server đã đăng nhập ở máy local.

**Nghiệm thu:** một yêu cầu Lead tạo ít nhất hai PeerTask, retry một Peer riêng và xuất báo cáo tổng hợp.

## P2 — Isolation & recovery (PR #8)

- [x] Git worktree riêng theo workflow/Git repo; source repo sạch, merge policy review-only (xuất patch, không tự áp dụng).
- [x] SQLite WAL snapshot, durable event journal có cursor và migration từ P1 state.json.
- [x] Restart reconciliation qua Codex thread/read & thread/turns/list; follow-up chủ động dùng thread/resume, không phát lại prompt cũ.
- [x] Artifact store SHA-256, diff viewer/tải patch và test runner độc lập từ modules[].testCommand.
- [x] Có chế độ Codex sandbox opt-in và giới hạn API shell command bằng argv cấu hình, localhost-only.
- [ ] Hard OS-level isolation và MCP allowlist trong YOLO mode: không thể được bảo đảm bằng app-server; cần sandbox/OS policy thực tế.
- [ ] Live Codex E2E với các Git repos thực trên máy người dùng.

**Nghiệm thu P2:** Peer chỉ ghi vào detached worktree; nguồn gốc sạch, artifact patch truy vết được; restart không phát lại lệnh tự động. Xem docs/P2.md.

## P3 — Experience (PR #10)

- [x] Bản đồ Agent kiểu isometric/2.5D tương tác: Lead → Peer modules → Final Reviewer; dữ liệu đến từ Task và Workflow đã lưu, có thể chọn Task để xem chi tiết.
- [x] Lịch sử Codex session có phân trang keyset, lọc role/status/workflow và thời gian thực thi (khi có timestamps).
- [x] Activity Timeline lọc theo Agent role, từ khóa, trạng thái, khoảng thời gian; SQLite Event Journal riêng có lọc prefix kind/task ID/từ khóa và cursor.
- [x] Thông báo trong ứng dụng được SQLite lưu bền cho Task failed/interrupted và Workflow chờ duyệt/cần xác minh/blocked/failed; có đánh dấu đã đọc.
- [x] Quan sát tiến trình Backend: RSS/heap, CPU time tích lũy, uptime; tổng Task active/queued và Workflow đang chờ người dùng.
- [x] Unit tests và CI cho projections, notification persistence/restart, filters, journal cursor và metrics.
- [—] Claude Code Adapter: **không cần trong P3 hiện tại** vì runtime đã đăng nhập bằng Codex CLI. Không bổ sung provider credentials hoặc mô phỏng Claude trong Codex Adapter.

**Nghiệm thu P3:** bản đồ không hiển thị Agent đang chạy khi không có Task; lỗi và bước chờ người dùng xuất hiện trong thông báo; lịch sử session và journal đọc được sau restart; metrics được gắn nhãn Backend, không ngụ ý là CPU/RAM từng Agent. Xem `docs/P3.md`.

Mỗi phase phải có test minh chứng; CI không thay thế live Codex E2E trên máy thực.
