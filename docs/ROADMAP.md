# Roadmap

## P0 — Foundation (PR này)

- [x] Mô tả mục tiêu, architecture, ranh giới của Lead/Peer.
- [x] Monorepo npm workspaces và shared contracts.
- [x] Local API, Workspace Registry, Task Store, Event SSE.
- [x] Codex JSON-RPC stdio Adapter, Thread/Turn lifecycle.
- [x] UI tối thiểu: Task, Run, Interrupt, Events, runtime Approval.
- [ ] Kiểm thử tích hợp với Codex CLI trên máy người dùng (cần Codex đăng nhập và module thật).

**Nghiệm thu:** cấu hình đường dẫn, tạo và chạy một Task, nhìn thấy event và trạng thái cuối.

## P1 — Lead-controlled dispatch

- [ ] `LeadPlan` và `PeerTask` schema có validation.
- [ ] Queue + dependency + concurrency limit theo module.
- [ ] Handoff kết quả Peer → Lead (artifact, diff, tests).
- [ ] Lead review → accept/rework với giới hạn vòng lặp, Business Approval.
- [ ] Bổ sung mock runtime và integration tests cho điều phối.

**Nghiệm thu:** một yêu cầu Lead tạo ít nhất hai PeerTask, retry một Peer riêng và xuất báo cáo tổng hợp.

## P2 — Isolation & recovery

- [ ] Git worktree theo repository và chính sách merge.
- [ ] SQLite/PostgreSQL state, durable event journal.
- [ ] Restart reconciliation, resume thread, không thực thi trùng.
- [ ] Artifact store, diff viewer, tests evidence.
- [ ] Permission boundary và shell/MCP policy theo Agent.

## P3 — Experience

- [ ] Bản đồ Agent/isometric UI.
- [ ] Runtime Adapter cho Claude Code (nếu cần).
- [ ] Lịch sử session, filter event, thông báo và quan sát tài nguyên.

Mỗi phase phải có test minh chứng, không coi checklist là bằng chứng chạy được trên máy thật.
