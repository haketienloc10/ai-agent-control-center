# Phân chia trách nhiệm của CoordinationStore

`CoordinationStore` giữ API công khai và event `change` cho coordinator, HTTP API
và các test. Refactor này giữ nguyên protocol, schema snapshot SQLite và nội dung
Context Packet.

| File trong `apps/api/src` | Trách nhiệm |
| --- | --- |
| `coordination-store.ts` | Facade, truy vấn state và phát `change` sau commit |
| `coordination-repository.ts` | Mở SQLite, đọc snapshot, clone candidate và commit nguyên tử |
| `context-packet.ts` | Chọn nguồn, xác định kiến thức đã có trong Thread, tạo checkpoint/delta và snapshot quyết định hiện tại |
| `lead-commands.ts` | Kiểm tra quyền/phase, xử lý `LeadCommand`, validation Task Brief, Decision Log và dedup `callId` |
| `coordination-lifecycle.ts` | Tạo conversation, chuyển trạng thái delivery/session, gộp event cho Lead, finish và recovery |
| `coordination-settings.ts` | Chuẩn hóa lựa chọn model/effort và App Settings |
| `coordination-state.ts` | Kiểu state và các thao tác cơ bản để tạo message/delivery |

## Ranh giới mutation

Mỗi lệnh đi qua `CoordinationStore.mutate()`. Repository clone state hiện tại,
chạy handler trên candidate, rồi ghi toàn bộ candidate bằng một SQLite UPSERT.
SQLite commit thành công trước khi thay state trong bộ nhớ và phát `change`.
Nếu validation hoặc ghi SQLite thất bại, state cũ được giữ và không phát event.

Handler Context Packet, Lead command và lifecycle không tự ghi SQLite hoặc phát
event. Session, message, delivery, routing phase và `handledToolCalls` của một
Lead command phải nằm trong cùng candidate, cùng một lần commit. Không chia
thành các lần ghi riêng theo entity.

Recovery dùng cùng cơ chế clone/commit nhưng chỉ ghi khi có turn `running` cần
chuyển sang `interrupted`; không phát `change` trong constructor. Không replay
turn đang chạy sau restart. Queued delivery và event batch tiếp tục được lưu.
Generation vẫn chặn báo cáo cũ đánh thức Lead sau finish hoặc khi task mở lại.

## Kiểm chứng

Các test đi qua API công khai của `CoordinationStore` để bảo vệ hành vi khi đổi
cách tổ chức bên trong: Context Packet, module ownership, Discovery phase,
idempotency, restart và late event. Test lỗi commit dùng SQLite trigger để từ
chối ghi sau khi handler đã tạo candidate; xác nhận state, dữ liệu trên đĩa và
`change` giữ nguyên, sau đó retry cùng `callId` thành công.
