# Mục tiêu MVP

Người dùng giao task cho Lead trong workspace chung. Lead điều phối Discovery và các Codex Peer sessions theo sự kiện.

## Năm nguyên tắc

1. Lead là người duy nhất chịu trách nhiệm toàn bộ task. Discovery và Peer chỉ chịu trách nhiệm trong phạm vi được giao.
2. Không có shared context ngầm. Mọi thông tin chuyển giữa agent phải được truyền tường minh, có nguồn gốc (Context Packet).
3. Lead không quyết định dựa trên suy đoán chưa được kiểm chứng. Thiếu tổng quan thì hỏi Discovery; thiếu bằng chứng chi tiết thì giao Peer; thiếu yêu cầu quan trọng thì hỏi người dùng.
4. Lead giao việc dựa trên dependency và kết quả thực tế. Không mặc định triển khai từ đầu, không giao song song những việc phụ thuộc vào thông tin chưa xác minh.
5. Lead chỉ kết thúc khi đã đối chiếu kết quả với yêu cầu người dùng. Báo cáo Peer là đầu vào để đánh giá, không phải quyết định hoàn thành thay Lead.

## Hành vi MVP

- Lead giao việc bằng dynamic tools rồi kết thúc turn; task vẫn active.
- Không dùng `assign_module` hoặc `send_discovery` để hỏi tiến độ. Peer và Discovery tự phát kết quả/lỗi để đánh thức Lead.
- Discovery là giai đoạn phải chờ kết quả: sau khi giao Discovery, Lead kết thúc turn và chỉ giao Peer hoặc `finish` sau khi có báo cáo/lỗi. App thực thi ranh giới này (`routingPhase`), đây là quyết định thiết kế có chủ đích.
- Chỉ `finish` khi toàn bộ task hoàn thành; phản hồi Peer/Discovery muộn không khôi phục task.
- Peer duy trì thread riêng trong module, có thể nhận yêu cầu thực sự mới hoặc sửa đổi ở lượt sau.
- Không Peer-to-Peer; mọi điều phối qua Lead.
- App quản lý delivery, SQLite, event và hiển thị trạng thái, không đánh giá chất lượng nghiệp vụ.

Chưa triển khai: watchdog 15 phút, Workflow Engine, DAG, quality gates, Final Reviewer bắt buộc, Git worktree, tự sửa conflict.

Reliability tối thiểu: không replay turn sau crash, dedup tool `callId`, không phát Lead event sau `finish`, không timeout cứng 10 phút. Backend chỉ bind localhost.
