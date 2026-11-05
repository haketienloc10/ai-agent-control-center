# Hướng dẫn contributor

- Ngôn ngữ tài liệu: tiếng Việt, giữ nguyên code, commands và identifiers.
- Mục tiêu duy nhất: Lead Agent điều phối các Codex Peer sessions qua messages.
- Không khôi phục Workflow Engine, LeadPlan, DAG, acceptance gates, Final Reviewer bắt buộc hoặc Business Approval.
- Chỉ Lead có quyền route Peer messages; Peer không tự giao tiếp với Peer.
- Lead ở workspace, Peer ở module path đã đăng ký, nhiều Peer có thể chung module.
- Không thêm Git worktree, Git conflict gate hoặc giới hạn số rework cho MVP.
- Codex app-server là transport; không gắn business logic vào JSON-RPC client.
- Giữ SQLite durability; turn `running` trước restart không được tự chạy lại.
- Peer mặc định YOLO theo yêu cầu MVP. App chỉ bind `127.0.0.1` và không có authentication.
- Khi thay đổi behavior: kiểm thử với fake Codex runtime và chỉ nói E2E thật đã chạy nếu có bằng chứng.
