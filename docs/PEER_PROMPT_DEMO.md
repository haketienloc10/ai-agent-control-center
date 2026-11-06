Demo prompt hai lượt Lead–App–Peer, sinh bằng `npm run demo:peer-prompts -- docs/PEER_PROMPT_DEMO.md`.

Dùng Store, Coordinator, Runtime và JSON-RPC stdio thật với app-server giả. Lead và báo cáo Peer được lập kịch bản; không chạy Codex/model, không triển khai tính năng dueDate hoặc kiểm thử tính năng đó.

Nội dung lấy từ request turn/start app đã gửi. Chỉ UUID được đổi thành alias và timestamp thành THOI_DIEM_NGUON để demo ổn định. Cùng một Peer Thread: thread/start → turn/start → thread/resume → turn/start. Instructions được đọc từ instructions/peer.md ở cả hai lượt.

Lượt 1:

```text
ASSIGNMENT: api-01

MODULE: api

ORIGINAL_USER_REQUEST:
Thêm dueDate cho Todo API. Giữ dữ liệu cũ và báo bằng chứng kiểm thử.

CURRENT_GOAL:
Todo API hỗ trợ dueDate và tiếp tục đọc được dữ liệu cũ.

ACCEPTANCE_CRITERIA:
- API nhận và lưu dueDate theo định dạng YYYY-MM-DD.
- Dữ liệu cũ không có dueDate vẫn đọc được.
- Có bằng chứng kiểm chứng những hành vi đã triển khai.

CURRENT_CONSTRAINTS:
- Chỉ sửa module api.
- Không tự chuyển timezone.
- Giữ dữ liệu hiện có.

ACTIVE_DECISIONS:
- D1 · due-date-format
  dueDate dùng YYYY-MM-DD. Chưa hỗ trợ null.
  Căn cứ: U1

PREVIOUS_CONTEXT:
Không có nguồn cũ được chọn.

NEW_SUPPORTING_CONTEXT:
U1 · user-request · user · THOI_DIEM_NGUON
dueDate dùng YYYY-MM-DD, không tự chuyển timezone.

WORK:
Xác minh cách API hiện nhận, lưu và đọc Todo.
Triển khai dueDate theo quyết định hiện hành.
Nếu source hoặc contract mâu thuẫn, báo Lead kèm bằng chứng.

EXPECTED_RESULT:
Báo hành vi đã thực hiện, file đã sửa, command/cwd/kết quả thực tế và phần chưa kiểm chứng.
```

Lượt 2:

```text
ASSIGNMENT: api-02

MODULE: api

CONTINUES: api-01

CURRENT_GOAL:
Todo API hỗ trợ dueDate và tiếp tục đọc được dữ liệu cũ.

ACCEPTANCE_CRITERIA:
- API nhận và lưu dueDate theo định dạng YYYY-MM-DD.
- Dữ liệu cũ không có dueDate vẫn đọc được.
- Có bằng chứng kiểm chứng những hành vi đã triển khai.

CURRENT_CONSTRAINTS:
- Chỉ sửa module api.
- Không tự chuyển timezone.
- Giữ dữ liệu hiện có.

ACTIVE_DECISIONS:
- D1 · due-date-format
  dueDate dùng YYYY-MM-DD. Chưa hỗ trợ null.
  Căn cứ: U1

PREVIOUS_CONTEXT:
- R1 · peer-report · peer · THOI_DIEM_NGUON
  Đã triển khai dueDate; còn thiếu validation ngày không hợp lệ.

NEW_SUPPORTING_CONTEXT:
Không có nguồn mới.

WORK:
Bổ sung validation để từ chối ngày không tồn tại, ví dụ 2026-02-30, cùng các giá trị sai định dạng.
Kiểm tra hồi quy ngày hợp lệ và dữ liệu cũ không có dueDate.
Đọc implementation hiện có trước khi sửa.

EXPECTED_RESULT:
Báo hành vi validation sau sửa, file đã sửa, command/cwd/kết quả thực tế và phần chưa kiểm chứng.
```

Lượt 2 vẫn có mục tiêu, tiêu chí, ràng buộc và quyết định hiện hành. Báo cáo dài không gửi lại; PREVIOUS_CONTEXT chứa metadata và tóm tắt do Lead cung cấp. Có regression kiểm tra payload runtime, cùng Thread, checkpoint và nguồn không bị lặp.
