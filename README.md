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
- `GET /api/snapshot` — conversations, sessions, messages, deliveries, modules.
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
