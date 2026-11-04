# AI Agent Control Center — Lead ↔ Peer MVP

**Mục tiêu:** bạn chỉ nói chuyện với một Lead Agent. Lead giữ Codex Thread trong workspace và tự điều phối nhiều Peer Agents ở các module. Các Peer **không giao tiếp trực tiếp với nhau**; mọi kết quả, câu hỏi, blocker và yêu cầu bổ sung đều được chuyển về Lead.

Không còn P1/P2/P3 Workflow Engine, acceptance gates, DAG, Final Review bắt buộc, human approval gate, rework limit, Git worktree hay tự động xuất patch. **Peer sửa trực tiếp module source** theo quyền Codex CLI trên máy local. Nhiều Peer có thể cùng sửa một module; MVP **không tự chống xung đột ghi file hoặc Git**. Bạn nên dùng workspace/module tin cậy và chủ động quản lý Git khi cần.

## Yêu cầu

- Node.js 22+, npm.
- Codex CLI đã cài và đăng nhập bằng subscription của bạn; cần hỗ trợ `codex app-server --listen stdio://`.
- Các thư mục workspace và module phải tồn tại.

## Cài đặt

```bash
npm install
cp config/workspace.example.json config/workspace.local.json
```

Sửa `config/workspace.local.json` bằng **đường dẫn tuyệt đối** đến workspace Lead và các module.

```bash
npm run dev:api
# Terminal khác
npm run dev:web
```

Mở [http://localhost:5173](http://localhost:5173). Backend chỉ bind `127.0.0.1:4317`.

Có thể truyền `WORKSPACE_CONFIG=/path/to/config.json`, `APP_DATA_DIR=/path/to/data` và `PORT=4317`.

## Quy trình

1. Người dùng gửi message mới tới Lead.
2. Lead có thể trả lời, `spawn_peer` trong module, `send_peer` tới session cũ, hoặc `finish`.
3. App chạy Codex CLI cho Peer ở đúng `cwd`, và giữ Thread ID để tiếp tục khi Lead giao thêm việc.
4. Peer trả văn bản tự nhiên về Lead; app tự chuyển tin nhắn đó đến Lead và chạy lượt Lead tiếp theo.
5. Lead chủ động quyết định đã đủ hay cần giao thêm việc. User có thể gửi message tiếp vào cuộc việc đã kết thúc để mở lại.

Ví dụ: “Xem module Web và tạo README.md”. Lead mở Peer Web, Peer viết file trực tiếp trong module, báo kết quả. Nếu còn thiếu cách build, Lead gửi tiếp vào **cùng Peer session**. Không có gate bắt buộc.

## API local

- `GET /api/health` — trạng thái Backend.
- `GET /api/snapshot` — danh sách conversations, sessions, messages, deliveries, modules.
- `GET /api/events` — SSE thông báo cập nhật.
- `POST /api/conversations` — `{"text":"Xem module Web và tạo README.md"}`.
- `POST /api/conversations/:id/messages` — `{"text":"Kiểm tra thêm phần cài đặt"}`.

Khi tạo Lead Thread mới, app đăng ký **Codex app-server dynamic tools** `spawn_peer`, `send_peer` và `finish`. Lead gọi tool trực tiếp; tên module, session và message (kể cả JSON API contract bên trong) được Codex truyền qua trường `arguments`, không cần tự ghép JSON chứa chuỗi JSON. App thực thi và trả kết quả cho Lead qua `item/tool/call`. Các tool là API điều phối, **không phải quality gate**.

Với Lead Thread đã được tạo trước bản vá (chưa có tools đăng ký), app vẫn giữ lịch sử Thread và dùng `turn/start.outputSchema` để Codex tạo một JSON envelope hợp lệ. Ví dụ tương thích:

```json
{
  "reply": "Tôi giao Peer Web thực hiện.",
  "commands": [
    { "type": "spawn_peer", "moduleId": "web", "label": "README Web",
      "message": "Đọc module Web và tạo README.md" }
  ]
}
```

Lead cũng có thể dùng `send_peer(sessionId,message)` hoặc `finish(summary)`. App không cho client/Peer gọi trực tiếp các action của Lead.

## Truyền lệnh bền vững

- **Lead Thread mới:** `thread/start.dynamicTools` (Codex experimental API) cho phép Agent gọi `spawn_peer`, `send_peer`, `finish` qua tool requests. App ghi lệnh vào SQLite trước khi trả kết quả cho Agent; `callId` được lưu để ngăn xử lý lại cùng tool call. Peer không có những tool này.
- **Lead Thread cũ:** công cụ chưa được đăng ký khi tạo Thread nên không thể tự thêm khi `thread/resume`. App dùng `turn/start.outputSchema` để Codex phát JSON hợp lệ và giữ lại Thread ID cũ. Nếu phiên Codex cũ không hỗ trợ `outputSchema`, app fallback về parser cũ và tối đa một lượt sửa cú pháp.
- **Tương thích:** nếu `thread/start.dynamicTools` bị từ chối rõ ràng vì phiên Codex không hỗ trợ, app tạo Lead Thread bằng giao thức JSON có `outputSchema`. Không thử tạo Thread lần hai sau lỗi timeout vì có thể tạo trùng.
- Một công cụ gọi thành công không bị thực hiện thêm lần nữa nếu Lead nhắc lại lệnh dưới dạng JSON trong câu trả lời cuối.
- Nếu Backend crash sau khi tool call đã được ghi, yêu cầu lặp cùng `callId` sẽ nhận kết quả idempotent. Delivery của Codex turn đang chạy vẫn được đánh dấu `interrupted` và không tự replay.

**Lưu ý:** `dynamicTools` còn là API experimental của Codex. Chưa kiểm thử live trên bản Codex CLI đang cài tại máy người dùng. Bạn nên dùng Codex CLI mới có hỗ trợ `codex app-server` và experimental dynamic tools.

## Persistence, crash và bảo mật

SQLite trong `APP_DATA_DIR/coordination.sqlite` lưu toàn bộ hội thoại, session/thread ID, message và delivery. Sau restart, delivery đang chạy chuyển thành `interrupted`, **không tự replay** Codex turn. Delivery vẫn `queued` chưa hề chạy được phép tiếp tục. Người dùng có thể nhắn Lead để điều phối lại.

Dữ liệu P1–P3 cũ **không được import hoặc chạy lại**; file DB cũ được để nguyên trên đĩa. Đây là breaking change về API/data model.

Lead chạy read-only. Peer mặc định dùng `approvalPolicy: "never"`, `danger-full-access` (YOLO) và ghi thẳng module source. Có thể chọn `CODEX_SECURITY_MODE=sandbox`, nhưng **không có OS-level isolation**, không có xác thực mạng và không bảo đảm ngăn Codex truy cập ngoài module khi YOLO. Chỉ chạy trên máy tin cậy; không expose Backend.

Xem [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) và [docs/GOALS.md](docs/GOALS.md).

## Kiểm chứng

```bash
npm run typecheck
npm test
npm run build
```

CI dùng fake Codex transport, không thay thế E2E với Codex thật trên máy bạn.
