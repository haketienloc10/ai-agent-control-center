# AI Agent Control Center — Event-driven Lead ↔ Peer

Người dùng giao task cho Lead Agent. Lead điều phối các Codex Peer sessions trong module được cấu hình. **Lead giao việc xong thì kết thúc turn; task vẫn active.** Khi Peer hoàn thành hoặc lỗi, app gửi event để Lead tiếp tục. Không polling bằng message.

## Yêu cầu

- Node.js 22+, npm.
- Codex CLI đã đăng nhập, hỗ trợ `codex app-server --listen stdio://` và experimental `thread/start.dynamicTools`.
- Workspace và module paths tồn tại, tin cậy.

## Khởi chạy

```sh
npm install
cp config/workspace.example.json config/workspace.local.json
# Chỉnh đường dẫn tuyệt đối trong config/workspace.local.json
npm run dev:api
# Terminal khác:
npm run dev:web
```

Mở http://localhost:5173. Backend chỉ bind `127.0.0.1:4317`. Có thể cấu hình `WORKSPACE_CONFIG`, `APP_DATA_DIR`, `PORT` hoặc `CODEX_SECURITY_MODE=sandbox`.

## Giao diện giám sát (Phase 1)

Giao diện Web dùng ba khu vực: **Sidebar** (chọn task, tạo yêu cầu, App Settings),
**Workspace** (trạng thái task, hội thoại và gửi Lead), **Agent Monitor**
(trạng thái Lead/Peer, lượt xử lý cuối, hoạt động gần đây và danh sách module).

- Mọi chỉ số và trạng thái đều được tính từ `GET /api/snapshot`, cập nhật bằng SSE `/api/events`; không polling Peer bằng message.
- `Idle` biểu thị Codex session không chạy turn; không đồng nghĩa task đã hoàn thành. Trạng thái task `finished` chỉ được tạo bởi `finish()`.
- Bảng sự kiện gần đây chỉ tổng hợp từ message đã lưu; chưa có progress stream hoặc event audit log chuyên dụng. Chỉ báo kết nối Backend qua SSE, không suy ra tình trạng Codex từ kết nối đó.
- `Xem luồng Lead ↔ Peer` hiển thị message routing dưới dạng các dòng có thể mở rộng. Chọn Peer ở panel bên phải để xem transcript của Peer.
- `App Settings` giữ hành vi model/effort của PR #12. Không có API mới hoặc thay đổi cơ chế điều phối của PR #13.
- Layout responsive ở màn hình nhỏ: sidebar dạng dải task ngang, Agent Monitor nằm dưới hội thoại.

## Hiển thị Markdown từ Codex

Các message Lead, Peer và System được Web render bằng `react-markdown` và `remark-gfm`
(heading, danh sách, bảng, code block, liên kết). Backend tiếp tục lưu nguyên văn `Message.text`;
không rewrite, ép format hoặc tóm tắt phản hồi Codex.

Báo cáo dài được thu gọn theo **chiều cao phần nội dung đã render**, không cắt chuỗi Markdown.
`Xem toàn bộ` / `Thu gọn` chỉ thay đổi trạng thái hiển thị. Raw HTML không được thực thi;
link dùng kiểm tra URL mặc định của renderer và mở an toàn, hình ảnh remote không tự tải.

## App Settings: model và reasoning effort

Mở **App Settings · Model / Effort** ở thanh bên để đặt cấu hình riêng cho Lead và Peer. UI lấy model và effort gợi ý từ Codex `model/list` qua `GET /api/models`. Khi catalog không khả dụng, người dùng vẫn có thể nhập model ID thủ công. Trường rỗng kế thừa cấu hình mặc định của Codex.

Settings lưu bền trong SQLite qua `PUT /api/settings` và được đưa vào `GET /api/snapshot`. **Lead defaults** áp dụng mỗi lượt Lead tiếp theo, kể cả Thread đang tồn tại. **Peer defaults** được chốt lúc `spawn_peer`; Peer đã tồn tại không thay đổi theo Settings mới.

Lead có thể override `model` và `effort` khi gọi dynamic tool `spawn_peer`. Thứ tự cho từng trường độc lập: `spawn_peer override → Peer App Settings → Codex default`. Codex kiểm tra model/effort có được hỗ trợ hay không; app không tự tạo model IDs hoặc đánh giá chất lượng đầu ra.

Runtime truyền `model` trong `thread/start` và `model`/`effort` trong `turn/start`. Logic event-driven, `finish`, chống late Peer event và giới hạn timeout của PR #13 vẫn giữ nguyên. Không có legacy JSON protocol.

## Lifecycle theo sự kiện

1. Người dùng tạo task. App tạo Lead delivery và bắt đầu một Codex turn.
2. Lead gọi các dynamic tools `spawn_peer` hoặc `send_peer` để giao việc thực sự rồi **kết thúc turn ngay**. Không chờ, không hỏi tiến độ. Task vẫn `active`.
3. Peer chạy tại module `cwd`; khi turn hoàn thành hoặc lỗi, app lưu event và đánh thức Lead. Nếu đã có Lead delivery đang chờ, event mới được gom cùng lượt; Lead đọc `RECENT_CONVERSATION`.
4. Lead xử lý event, giao thêm việc nếu cần hoặc kết thúc turn để chờ event mới. `send_peer` chỉ cho instruction mới, sửa/bổ sung việc, không phải status poll.
5. Chỉ khi **toàn task** hoàn thành, Lead gọi `finish(summary)`. Lệnh này đánh dấu `finished` và phát một summary. Delivery chưa chạy chuyển sang `superseded`. Kết quả Peer đang chạy đến muộn vẫn được lưu nhưng không tự đánh thức Lead.
6. Chỉ một message mới từ người dùng mới mở lại conversation đã `finished`.

## Điều phối và giao thức

- Chỉ dùng Codex dynamic tools: `spawn_peer`, `send_peer`, `finish`. Không dùng JSON envelope, `outputSchema`, parser hoặc fallback protocol cũ.
- Codex CLI không hỗ trợ dynamic tools sẽ trả lỗi; cần cập nhật CLI. Với các Conversation Lead cũ không có tool registry, hãy tạo Conversation mới.
- Tool call được lưu SQLite atomically kèm `callId`, chống xử lý lặp cùng lời gọi.
- Peer không có routing tools và không giao tiếp Peer-to-Peer.
- Nhiều Peer có thể chạy trong cùng module, không có Git worktree hay tự động xử lý conflict.

## Recovery và timeout

- **Không còn timeout cứng 10 phút cho Codex turn.** App chờ terminal event từ Codex hoặc process exit.
- RPC request như `thread/start` vẫn có timeout kết nối riêng; đó không phải timeout thực thi task.
- Sau restart, delivery đang chạy thành `interrupted`, không tự replay. Delivery chưa chạy vẫn ở queue.
- SQLite nằm tại `APP_DATA_DIR/coordination.sqlite` (mặc định `.data/coordination.sqlite`).
- **Watchdog định kỳ 15 phút chưa triển khai.** Peer bị treo khi process còn sống nhưng không gửi terminal event có thể chờ vô hạn cho đến khi được xử lý thủ công.

## API local

- `GET /api/health` — trạng thái Backend.
- `GET /api/snapshot` — conversations, sessions, messages, deliveries, modules và settings.
- `GET /api/models` — model/effort catalog do Codex app-server cung cấp.
- `PUT /api/settings` — lưu `{"lead":{"model":"MODEL_ID","effort":"high"},"peer":{"model":"MODEL_ID","effort":"medium"}}`; dùng `""` để kế thừa Codex.
- `GET /api/events` — SSE thay đổi.
- `POST /api/conversations` — tạo task từ `{"text":"Yêu cầu"}`.
- `POST /api/conversations/:id/messages` — gửi bổ sung cho Lead.

## Kiểm thử

```sh
npm run typecheck
npm test
npm run build
```

CI dùng fake Codex transport, không thay thế E2E thực tế với Codex CLI. Xem [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Bảo mật:** Lead read-only; Peer mặc định `approvalPolicy: never` và `danger-full-access`. Backend không có authentication và chỉ bind localhost. Không expose lên Internet.
