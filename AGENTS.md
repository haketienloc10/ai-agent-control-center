# Hướng dẫn contributor

- Tài liệu cho người đọc viết bằng tiếng Việt, giữ nguyên API, identifier, command và error.
- Lead là trung tâm quyết định; Discovery/Peer có session và context độc lập, chỉ nhận Context Packet đã chọn.
- Khi đổi protocol, cập nhật `lead-tools.ts`, contracts, store, `instructions/*.md`, UI trace và tests đồng bộ.
- Quy tắc vai trò nằm trong `instructions/lead.md`, `discovery.md`, `peer.md` (file nào không có thì vai trò đó không có quy tắc); code chỉ nối thêm dữ liệu phiên (path, module).
- `update_task_brief` chỉ lưu đánh giá của Lead, không tạo quality gate hoặc quyết định thay Lead.
- Discovery định hướng sơ bộ, Peer xác minh source và sửa code. Không phối hợp trực tiếp Peer-to-Peer.
- Mỗi module có đúng một Peer (`assign_module(moduleId)`); Peer chỉ sửa module của mình. Lead quyết điều nhiều module cùng phụ thuộc bằng `record_decision`; App chỉ lưu và chuyển quyết định, không đánh giá.
- Giữ event-driven, không polling, `callId` idempotent, SQLite transaction và generation chống late event.
- Không thêm Workflow Engine, reviewer bắt buộc, JSON routing hay fallback parser.
- Không replay running turn sau restart; không gắn timeout cứng vào Codex turn.
- Lead chỉ đọc/ghi trong `lead.cwd`; đọc source hoặc chạy lệnh trong module phải giao Discovery/Peer (ràng buộc bằng chỉ dẫn, không bằng sandbox).
- Peer/Discovery mặc định có quyền runtime rộng. Backend bind localhost, không có authentication.
- Không tuyên bố Codex E2E thật nếu chỉ chạy test fake transport.
