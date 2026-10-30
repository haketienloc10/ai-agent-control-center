# Mục tiêu sản phẩm

## Bối cảnh

Hiện tại người dùng mở terminal trong một **workspace chung** để chạy Lead Agent. Lead phân tích yêu cầu và phân công cho các Peer Agent. Các Peer thực hiện công việc trên **những source module nằm bên ngoài workspace chung**, gửi kết quả cho Lead kiểm tra; Lead có thể yêu cầu sửa và chạy lại.

AI Agent Control Center thay đổi **cách điều khiển và quan sát** quy trình này từ terminal sang Dashboard; không thay thế Codex bằng một LLM API riêng.

## Mục tiêu

1. Quản lý Lead, Peer, Task, Codex Thread/Turn và đường dẫn module trong một giao diện.
2. Hiển thị trạng thái, lịch sử hoạt động và kết quả theo thời gian thực. Trong YOLO mode không có runtime approval; Business Approval cuối workflow vẫn được giữ.
3. Định tuyến filesystem: Lead khởi chạy với `cwd` của workspace chung, Peer với `cwd` module được đăng ký; đây không phải rào chắn bảo mật trong YOLO mode.
4. Giữ quyền kiểm soát của con người với các thao tác nhạy cảm, các quyết định chấp nhận kết quả và merge.
5. Có lớp `AgentRuntime` tách khỏi nghiệp vụ để sau này hỗ trợ Claude Code khi cần.

## Success criteria của foundation

- Một người dùng cấu hình lead workspace và ít nhất một source module ngoài repo.
- UI tạo được Task cho Lead hoặc Peer, Backend ghi Task bền vững.
- Backend khởi chạy Codex app-server qua stdio, tạo Thread/Turn và nhận event.
- UI phản ánh Task status, event stream và runtime approval.
- Có thể interrupt một Turn đang chạy.
- Có ranh giới rõ giữa session thực tế của Codex và Task do ứng dụng sở hữu.

## Ngoài phạm vi foundation

- Lead tự lập kế hoạch theo schema rồi tự dispatch Peer và tự lặp review/rework.
- Quản lý Git worktree, diff viewer, merge, CI và tự động publish.
- Multi-user, đăng nhập từ xa, billing, cloud hosting.
- 3D/isometric game UI theo ảnh; ưu tiên dữ liệu và luồng vận hành thật.
- Cam kết isolation tuyệt đối bằng cách đặt `cwd`. Codex sandbox và quyền filesystem của host vẫn phải được cấu hình/kiểm chứng.

## Nguyên tắc

Ứng dụng quản lý **Task, Agent definition, Session mapping, Approval, Event**; Codex quản lý **agent loop, tools và context của từng Thread**. Phân công và review nghiệp vụ thuộc ứng dụng/Lead, không gán cho Codex app-server.
