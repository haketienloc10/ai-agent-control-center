# Hướng dẫn contributor

- Tài liệu cho người đọc viết bằng tiếng Việt, giữ nguyên API, identifier, command và error.
- Lead là trung tâm quyết định; Discovery/Peer có session và context độc lập, chỉ nhận Context Packet đã chọn.
- Khi đổi protocol, cập nhật `lead-tools.ts`, contracts, store, worker prompts, UI trace và tests đồng bộ.
- `update_task_brief` chỉ lưu đánh giá của Lead, không tạo quality gate hoặc quyết định thay Lead.
- Discovery định hướng sơ bộ, Peer xác minh source và sửa code. Không phối hợp trực tiếp Peer-to-Peer.
- Giữ event-driven, không polling, `callId` idempotent, SQLite transaction và generation chống late event.
- Không thêm Workflow Engine, reviewer bắt buộc, JSON routing hay fallback parser.
- Không replay running turn sau restart; không gắn timeout cứng vào Codex turn.
- Peer/Discovery mặc định có quyền runtime rộng. Backend bind localhost, không có authentication.
- Không tuyên bố Codex E2E thật nếu chỉ chạy test fake transport.
