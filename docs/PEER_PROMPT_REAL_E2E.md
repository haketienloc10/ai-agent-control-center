# Đối chiếu prompt bằng Codex thật

Lần chạy ngày 06/11/2026 với Codex CLI 0.167.0, cả Lead, Discovery và Peer dùng `gpt-6-luna`. Kết quả: **PASS**. Store SQLite → Coordinator → Codex app-server stdio thật, không lập kịch bản trả lời hoặc tool call của model. Harness yêu cầu kịch bản hai assignment và Discovery trước; không chứng minh Lead sẽ tự chọn cùng cách chia việc cho yêu cầu tùy ý.

Chạy lại bằng `npm run e2e:codex`. Lệnh tốn token; fixture nằm riêng trong thư mục tạm. Evidence lần chạy này nằm tại `.data/codex-e2e/2026-11-06T13-53-51.016Z/`: `requests.jsonl`, `lead-tool-calls.jsonl`, `snapshot.json`, `peer-turn-1.txt`, `peer-turn-2.txt`, `fixture-tests.txt`, `result.json`. Evidence local không commit. Harness giữ fixture để kiểm tra sau chạy; đường dẫn nằm trong `fixture-path.txt`.

## Kết quả so với demo

Đối chiếu với [PEER_PROMPT_DEMO.md](PEER_PROMPT_DEMO.md):

| Kiểm tra | Kết quả |
| --- | --- |
| Tên và thứ tự section của cả hai lượt | Khớp |
| Lượt 1 có ORIGINAL_USER_REQUEST; lượt 2 chỉ có CONTINUES | Đạt |
| Goal, tiêu chí, constraints và quyết định lặp đủ ở lượt 2 | Đạt |
| Một Peer session, một thread/start và một thread/resume | Đạt |
| PREVIOUS_CONTEXT chứa metadata và tóm tắt do Lead thật viết | Đạt |
| Lượt 2 không gửi lại nguyên văn báo cáo/nguồn đã nhận | Đạt |
| Quy tắc peer.md gửi qua developerInstructions ở cả hai lượt | Đạt |
| Toàn văn prompt giống demo | Không; đây là nội dung do Lead thật viết |

Khác biệt nội dung có chủ đích: yêu cầu E2E dài hơn để chỉ định hai assignment; Lead viết 4 tiêu chí thay vì 3 câu trong demo; nguồn mới lượt đầu là báo cáo Discovery thay vì user follow-up; WORK, EXPECTED_RESULT và tóm tắt lượt 2 phản ánh kết quả thực tế. App vẫn dùng cùng formatter và cùng quy tắc snapshot/dedup. Không thay demo cố định thành transcript này.

Code do Peer thật sửa vượt qua 6 bài `node --test`. Oracle độc lập của harness xác minh lưu/đọc ngày hợp lệ, năm nhuận, từ chối ngày sai và null, tương thích dữ liệu cũ. Phạm vi là E2E điều phối và thư viện Node; không có HTTP hoặc browser UI E2E.

## Payload Peer thực tế

Hai khối dưới lấy trực tiếp từ `turn/start.input[0].text`. Chỉ đổi UUID thành alias, thư mục tạm thành FIXTURE và timestamp thành THOI_DIEM_NGUON. Không tóm tắt hoặc viết lại nội dung Lead/Discovery. Payload developerInstructions được kiểm tra riêng và không nằm trong hai khối prompt này.

### Lượt 1

```text
ASSIGNMENT: api-01

MODULE: api

ORIGINAL_USER_REQUEST:
Thêm dueDate cho Todo API. Giữ dữ liệu cũ và báo bằng chứng kiểm thử.
Đây là kịch bản E2E hai assignment thực, không phải yêu cầu lập kế hoạch:
1. Giao Discovery khảo sát sơ bộ module api trước. Sau báo cáo Discovery mới giao Peer.
2. Cập nhật Task Brief với goal "Todo API hỗ trợ dueDate và tiếp tục đọc được dữ liệu cũ.", tiêu chí gồm nhận/lưu YYYY-MM-DD, đọc dữ liệu cũ không dueDate và có bằng chứng kiểm thử. Record decision due-date-format: dueDate dùng YYYY-MM-DD, chưa hỗ trợ null, không chuyển timezone, affects api. Dùng message user này làm evidenceRef.
3. Assignment Peer đầu: triển khai createTodo nhận và giữ dueDate; readTodo giữ dữ liệu cũ. Chỉ kiểm tra định dạng, CHƯA kiểm tra ngày có tồn tại trong lịch; phần kiểm tra ngày dành riêng cho assignment thứ hai. Peer chạy node --test và báo cáo thật. Gửi nguồn Discovery bằng contextRefs.
4. Sau báo cáo Peer đầu, giao assignment thứ hai cho cùng module: từ chối ngày không tồn tại như 2026-02-30, hỗ trợ năm nhuận, hồi quy ngày hợp lệ và dữ liệu cũ. Giữ nguyên goal/criteria và decision. Chọn báo cáo Peer trước bằng contextRefs và viết previousContext.summary dựa trên báo cáo đó. Không đính kèm lại nguồn Discovery ở lượt này.
Mỗi assignment gửi đủ constraints: "Chỉ sửa module api.", "Không tự chuyển timezone.", "Giữ dữ liệu hiện có."; không override model/effort. WORK và EXPECTED_RESULT do bạn viết dựa trên tình trạng thực tế. Chỉ finish sau báo cáo Peer thứ hai và đối chiếu kết quả.
Fixture là thư viện Node ESM todo.mjs, không có HTTP server/UI; sửa ngay fixture, không cần dựng framework hoặc hỏi thêm. Không đọc source module từ Lead. Không thêm dependency.

CURRENT_GOAL:
Todo API hỗ trợ dueDate và tiếp tục đọc được dữ liệu cũ.

ACCEPTANCE_CRITERIA:
- CreateTodo nhận và lưu dueDate dạng YYYY-MM-DD.
- ReadTodo đọc được dữ liệu cũ không có dueDate.
- Từ chối ngày không tồn tại, hỗ trợ năm nhuận và hồi quy ngày hợp lệ.
- Có bằng chứng kiểm thử node --test.

CURRENT_CONSTRAINTS:
- Chỉ sửa module api.
- Không tự chuyển timezone.
- Giữ dữ liệu hiện có.

ACTIVE_DECISIONS:
- D1 · due-date-format
  dueDate dùng định dạng YYYY-MM-DD; hiện chưa hỗ trợ null; không chuyển timezone.
  Căn cứ: U0

PREVIOUS_CONTEXT:
Không có nguồn cũ được chọn.

NEW_SUPPORTING_CONTEXT:
DISCOVERY-1 · discovery-preliminary · discovery · THOI_DIEM_NGUON
Khảo sát sơ bộ module `api`:

- [todo.mjs](FIXTURE/api/todo.mjs) là entry point. `createTodo(input)` hiện chỉ trả về `id` và `title`; `readTodo(stored)` trả về bản sao bằng `structuredClone`.
- [todo.test.mjs](FIXTURE/api/todo.test.mjs) có một bài kiểm tra `dữ liệu cũ`, xác nhận cả hai hàm xử lý Todo không có `dueDate`.
- Lệnh kiểm thử phù hợp với cấu trúc hiện tại là `node --test` trong thư mục `api`. Chưa chạy kiểm thử theo yêu cầu chỉ khảo sát.

Hai file trên là toàn bộ fixture được tìm thấy. Chưa khảo sát sâu ngoài các entry point và kiểm thử hiện có; chưa xác minh hành vi với `dueDate`.

WORK:
Trong fixture Node ESM `todo.mjs`, triển khai assignment đầu: `createTodo` nhận và giữ lại `dueDate` khi được cung cấp, chỉ kiểm tra định dạng YYYY-MM-DD; `readTodo` tiếp tục đọc Todo cũ không có `dueDate`. Chạy `node --test` từ module và báo cáo thay đổi cùng đầu ra kiểm thử thật. Không thực hiện kiểm tra xem ngày có tồn tại trong lịch; đó là phạm vi assignment sau.

EXPECTED_RESULT:
Thay đổi trong module api để nhận/lưu dueDate theo định dạng đã thống nhất và tương thích dữ liệu cũ; báo cáo file sửa, hành vi và bằng chứng đầu ra `node --test`.
```

### Lượt 2

```text
ASSIGNMENT: api-02

MODULE: api

CONTINUES: api-01

CURRENT_GOAL:
Todo API hỗ trợ dueDate và tiếp tục đọc được dữ liệu cũ.

ACCEPTANCE_CRITERIA:
- CreateTodo nhận và lưu dueDate dạng YYYY-MM-DD.
- ReadTodo đọc được dữ liệu cũ không có dueDate.
- Từ chối ngày không tồn tại, hỗ trợ năm nhuận và hồi quy ngày hợp lệ.
- Có bằng chứng kiểm thử node --test.

CURRENT_CONSTRAINTS:
- Chỉ sửa module api.
- Không tự chuyển timezone.
- Giữ dữ liệu hiện có.

ACTIVE_DECISIONS:
- D1 · due-date-format
  dueDate dùng định dạng YYYY-MM-DD; hiện chưa hỗ trợ null; không chuyển timezone.
  Căn cứ: U0

PREVIOUS_CONTEXT:
- R1 · peer-report · peer · THOI_DIEM_NGUON
  Peer báo cáo assignment đầu đã cập nhật todo.mjs để createTodo giữ dueDate và kiểm tra cú pháp YYYY-MM-DD, từ chối null; readTodo vẫn đọc Todo cũ thiếu dueDate. todo.test.mjs bổ sung kiểm tra lưu ngày, cú pháp/null và dữ liệu cũ/mới. node --test đạt 4 bài, 0 lỗi. 2026-02-30 chưa bị từ chối và là việc để assignment này xử lý.

NEW_SUPPORTING_CONTEXT:
Không có nguồn mới.

WORK:
Bổ sung kiểm tra ngày lịch cho `dueDate` trong fixture hiện tại. Từ chối ngày không tồn tại như `2026-02-30`; chấp nhận ngày hợp lệ, bao gồm 29/02 năm nhuận và kiểm tra trường hợp năm không nhuận. Giữ tương thích dữ liệu cũ không có dueDate và các hành vi lưu/đọc đã có. Thêm/cập nhật các kiểm thử tương ứng, chạy `node --test` trong module api và báo cáo đầu ra thật.

EXPECTED_RESULT:
Todo API chỉ chấp nhận dueDate vừa đúng YYYY-MM-DD vừa là ngày có thật trong lịch; năm nhuận và ngày hợp lệ được chấp nhận, dữ liệu cũ vẫn đọc được. Báo cáo sửa đổi và bằng chứng node --test.
```
