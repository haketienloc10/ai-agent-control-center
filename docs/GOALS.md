# Mục tiêu MVP

Người dùng giao task cho Lead trong workspace chung. Lead điều phối nhiều Codex Peer sessions theo sự kiện.

- Lead giao việc bằng dynamic tools rồi kết thúc turn; task vẫn active.
- Không dùng `send_peer` để hỏi tiến độ. Peer tự phát kết quả/lỗi để đánh thức Lead.
- Chỉ `finish` khi toàn bộ task hoàn thành; phản hồi Peer muộn không khôi phục task.
- Peer duy trì thread riêng trong module, có thể nhận yêu cầu thực sự mới hoặc sửa đổi ở lượt sau.
- Không Peer-to-Peer; mọi điều phối qua Lead.
- App quản lý delivery, SQLite, event và hiển thị trạng thái, không đánh giá chất lượng nghiệp vụ.

Chưa triển khai: watchdog 15 phút, Workflow Engine, DAG, quality gates, Final Reviewer bắt buộc, Git worktree, tự sửa conflict.

Reliability tối thiểu: không replay turn sau crash, dedup tool `callId`, không phát Lead event sau `finish`, không timeout cứng 10 phút. Backend chỉ bind localhost.
