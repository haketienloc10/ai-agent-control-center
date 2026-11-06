# AI Agent Control Center — Event-driven Discovery → Lead ↔ Peer

Người dùng giao task mới; Discovery có thể khảo sát sơ bộ source trong **session riêng, read-only**, rồi chuyển báo cáo cho Lead. Lead tự quyết định có cần giao Peer điều tra sâu hay triển khai. **Lead giao việc xong thì kết thúc turn; task vẫn active.** Khi Peer hoàn thành hoặc lỗi, app gửi event để Lead tiếp tục. Không polling bằng message.

## Yêu cầu

- Node.js 22+, npm.
- Codex CLI đã đăng nhập, hỗ trợ `codex app-server --listen stdio://` và experimental `thread/start.dynamicTools`.
- Workspace và module paths tồn tại, tin cậy.

## Khởi chạy

```sh
npm install
cp config/workspace.example.json config/workspace.local.json
# Chỉnh đường dẫn tuyệt đối trong config/workspace.local.json
# Tạo thư mục discovery.cwd riêng, ví dụ: mkdir -p /ABSOLUTE/PATH/TO/discovery-workspace
npm run dev:api
# Terminal khác:
npm run dev:web
```

Mở http://localhost:5173. Backend chỉ bind `127.0.0.1:4317`. Có thể cấu hình `WORKSPACE_CONFIG`, `APP_DATA_DIR`, `PORT` hoặc `CODEX_SECURITY_MODE=sandbox`.

## Giao diện giám sát (Phase 1)

Giao diện Web dùng ba khu vực: **Sidebar** (chọn task, tạo yêu cầu, App Settings),
**Workspace** (trạng thái task, hội thoại và gửi Lead), **Agent Monitor**
(trạng thái Discovery/Lead/Peer, lượt xử lý cuối, hoạt động gần đây và danh sách module).

- Mọi chỉ số và trạng thái đều được tính từ `GET /api/snapshot`, cập nhật bằng SSE `/api/events`; không polling Peer bằng message.
- `Idle` biểu thị Codex session không chạy turn; không đồng nghĩa task đã hoàn thành. Trạng thái task `finished` chỉ được tạo bởi `finish()`.
- Bảng sự kiện gần đây chỉ tổng hợp từ message đã lưu; chưa có progress stream hoặc event audit log chuyên dụng. Chỉ báo kết nối Backend qua SSE, không suy ra tình trạng Codex từ kết nối đó.
- `Xem luồng điều phối` hiển thị message routing (Discovery → Lead và Lead ↔ Peer) dưới dạng các dòng có thể mở rộng. Chọn Discovery hoặc Peer ở panel bên phải để xem báo cáo hoặc transcript.
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

## Discovery: khám phá sơ bộ trước Lead

- Khai báo `discovery.cwd` riêng trong `config/workspace.local.json` để bật Discovery. Nếu không khai báo, luồng Lead ↔ Peer cũ giữ nguyên.
- `discovery.mode`: `auto` (mặc định khi đã khai báo, chạy với task mới; bỏ qua những yêu cầu thuần hỏi trạng thái/tiến độ), `always` (mọi task mới), `off` (tắt). **Không chạy lại theo từng Lead turn hoặc khi người dùng tiếp tục conversation cũ.** Cách nhận diện `auto` là heuristic đơn giản, không phải phân loại bằng LLM.
- `discovery.model` và `discovery.effort` tùy chọn, độc lập với Lead/Peer Settings; để trống sẽ kế thừa Codex mặc định.
- Discovery có Codex session/thread riêng với `cwd=discovery.cwd`. App-server dùng **named permissions profile** được khai báo qua `thread/start.config`, chọn bằng `thread/start.permissions`, sau đó dùng `turn/start.permissions`; `runtimeWorkspaceRoots` gồm Discovery workspace và các module. Profile cấp `read` cho `:workspace_roots` và `:minimal`, tắt network, không cấp `write`. Không dùng `readOnly.access` đã bị loại bỏ, không kết hợp `permissions` với `sandbox`/`sandboxPolicy` và không truyền CLI `--add-dir` vào JSON RPC. Cần Codex app-server hỗ trợ permission profiles và `runtimeWorkspaceRoots` (experimental API). Nếu Codex từ chối profile, Discovery báo lỗi cho Lead; app không tự hạ quyền kiểm soát đọc xuống chế độ full read.
- Discovery chỉ đọc có chọn lọc để hiểu module, công nghệ, entry point và vùng có khả năng liên quan. **Không sửa code, truy vết sâu, phân tích root cause, tự lập kế hoạch hay quyết định thay Lead.** Discovery không có dynamic routing tools. Quy tắc thay đổi theo repository nằm trong `AGENTS.md` do Codex đọc.
- Báo cáo Discovery là message `discovery → lead`, không phải Peer report hoặc kết quả triển khai. Lead chỉ nhận báo cáo và có thể giao Peer khảo sát sâu khi thiếu bằng chứng.
- Nếu Discovery gặp lỗi hoặc bị restart trong lúc chạy, app báo lỗi và **đánh thức Lead một lần** để tiếp tục mà không có báo cáo; không replay turn đã chạy.

## Lifecycle theo sự kiện

1. Người dùng tạo task. Nếu Discovery được kích hoạt, app tạo Discovery delivery trước và chỉ tạo Lead delivery khi Discovery hoàn tất hoặc gặp lỗi. Nếu không, tạo Lead delivery như trước.
2. Lead gọi các dynamic tools `spawn_peer` hoặc `send_peer` để giao việc thực sự rồi **kết thúc turn ngay**. Không chờ, không hỏi tiến độ. Task vẫn `active`.
3. Peer chạy tại module `cwd`; khi turn hoàn thành hoặc lỗi, app lưu event và đánh thức Lead. Nếu đã có Lead delivery đang chờ, event mới được gom cùng lượt; Lead đọc `RECENT_CONVERSATION`.
4. Lead xử lý event, giao thêm việc nếu cần hoặc kết thúc turn để chờ event mới. `send_peer` chỉ cho instruction mới, sửa/bổ sung việc, không phải status poll.
5. Chỉ khi **toàn task** hoàn thành, Lead gọi `finish()` để đổi trạng thái sang `finished` (không nhận `summary`). Sau khi tool thành công, báo cáo cuối lấy từ Codex `finalText` và được lưu một lần. Nếu turn thành công nhưng `finalText` rỗng, app thông báo `Task đã hoàn thành.`; nếu turn lỗi sau finish, app hiển thị lỗi bằng system message. Delivery chưa chạy chuyển sang `superseded`; Peer trả kết quả muộn không đánh thức Lead.
6. Chỉ một message mới từ người dùng mới mở lại conversation đã `finished`.

## Điều phối và giao thức

- Chỉ dùng Codex dynamic tools: `spawn_peer`, `send_peer`, `finish`. Không dùng JSON envelope, `outputSchema`, parser hoặc fallback protocol cũ.
- Codex CLI không hỗ trợ dynamic tools sẽ trả lỗi; cần cập nhật CLI. Với các Conversation Lead cũ không có tool registry, hãy tạo Conversation mới.
- Tool call được lưu SQLite atomically kèm `callId`, chống xử lý lặp cùng lời gọi.
- Discovery và Peer không có routing tools. Discovery có session, cwd và quyền read-only riêng; Peer thực thi trong module và không giao tiếp Peer-to-Peer.
- Nhiều Peer có thể chạy trong cùng module, không có Git worktree hay tự động xử lý conflict.

## Recovery và timeout

- **Không còn timeout cứng 10 phút cho Codex turn.** App chờ terminal event từ Codex hoặc process exit.
- RPC request như `thread/start` vẫn có timeout kết nối riêng; đó không phải timeout thực thi task.
- Sau restart, delivery đang chạy thành `interrupted`, không tự replay. Discovery bị gián đoạn sẽ đánh thức Lead bằng thông báo lỗi; delivery chưa chạy vẫn ở queue.
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

**Bảo mật:** Lead read-only; Discovery read-only với readableRoots chỉ định (và platform defaults); Peer mặc định `approvalPolicy: never` và `danger-full-access`. Backend không có authentication và chỉ bind localhost. Không expose lên Internet.
