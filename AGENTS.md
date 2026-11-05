# Hướng dẫn contributor

- Tài liệu hướng người đọc bằng tiếng Việt; giữ nguyên API và identifiers.
- Lead điều phối theo event: giao việc rồi kết thúc turn; chỉ tiếp tục khi có event User/Peer.
- Không polling Peer bằng `send_peer`. Chỉ gửi instruction mới, sửa hoặc bổ sung công việc.
- `finish` chỉ khi toàn task hoàn thành; Peer report đến muộn không được mở lại task hoặc đánh thức Lead.
- Chỉ dùng Codex dynamic tools; không tái tạo JSON routing, parser, `outputSchema` fallback hoặc function cũ.
- Không khôi phục Workflow Engine, DAG, approval gate, Final Reviewer bắt buộc.
- Peer ghi thẳng module, không thêm Git worktree; nhiều Peer có thể chung module.
- Giữ SQLite durability và không replay running turn sau crash.
- Không đặt timeout 10 phút cho Codex turn; watchdog 15 phút để giai đoạn sau.
- Peer mặc định YOLO, Backend chỉ bind localhost và không có authentication.
- Test với fake Codex; chỉ báo E2E thật nếu thực sự chạy.
