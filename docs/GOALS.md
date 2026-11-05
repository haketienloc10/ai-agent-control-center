# Mục tiêu MVP

Thay việc người dùng phải quản lý thủ công nhiều Codex sessions bằng một **Lead Agent** ở workspace chung.

- Người dùng chỉ cần giao tiếp với Lead.
- Lead quyết định tạo/resume bao nhiêu Peer sessions trong module nào.
- Mỗi Peer duy trì Codex Thread riêng, có thể nhận nhiều lượt yêu cầu liên tục.
- Cùng một module có thể có nhiều Peer sessions độc lập.
- Không có đường giao tiếp Peer-to-Peer; mọi dữ liệu qua Lead.
- Lead quyết định bổ sung, làm lại, giải quyết blocker và hoàn thành.
- App chỉ truyền message, chạy session, lưu trạng thái và hiển thị kết quả.

**Ngoài MVP:** workflow quality gates, DAG, acceptance checklist, Final Reviewer bắt buộc, Business Approval, Git worktree isolation, Git conflict prevention, patch approval, provider adapter khác Codex.

Giữ an toàn kỹ thuật tối thiểu: không tự replay turn sau crash, không định tuyến sai session/module, API chỉ bind localhost.
