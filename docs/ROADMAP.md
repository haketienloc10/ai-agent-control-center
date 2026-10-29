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
- [x] Handoff `PeerResult` có changedFiles/tests/risks sang Lead review. Đây là **self-report**, chưa có Git diff và artifact verification độc lập.
- [x] Lead review → accept/rework với tối đa 2 reworks/Peer, Business Approval trên UI.
- [x] Mock executor + tests kiểm tra dependency/rework/concurrency/restart.
- [ ] Live integration E2E với Codex app-server đã đăng nhập ở máy local.

**Nghiệm thu:** một yêu cầu Lead tạo ít nhất hai PeerTask, retry một Peer riêng và xuất báo cáo tổng hợp.

## P2 — Isolation & recovery

- [ ] Git worktree theo repository và chính sách merge.
- [ ] SQLite/PostgreSQL state, durable event journal.
- [ ] Restart reconciliation, resume thread, không thực thi trùng.
- [ ] Artifact store, diff viewer và xác minh tests evidence độc lập.
- [ ] Permission boundary và shell/MCP policy theo Agent.

## P3 — Experience

- [ ] Bản đồ Agent/isometric UI.
- [ ] Runtime Adapter cho Claude Code (nếu cần).
- [ ] Lịch sử session, filter event, thông báo và quan sát tài nguyên.

Mỗi phase phải có test minh chứng, không coi checklist là bằng chứng chạy được trên máy thật.
