# AI Agent Control Center — Event-driven Lead ↔ Discovery / Peer

Người dùng giao task cho Lead. Lead có thể yêu cầu **Discovery Agent** khám phá sơ bộ nhiều module, hoặc giao Peer điều tra chi tiết và triển khai. Discovery dùng session/thread và cwd riêng, chính sách thực thi giống Peer. **Lead giao việc xong thì kết thúc turn; task vẫn active.** App chuyển kết quả/lỗi Discovery và Peer qua event để Lead tiếp tục, không polling.

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

## Giao diện giám sát

Giao diện Web dùng ba khu vực: **Sidebar** (chọn task, tạo yêu cầu, App Settings),
**Workspace** (trạng thái task, hội thoại và gửi Lead), **Agent Monitor**
(trạng thái Discovery/Lead/Peer, lượt xử lý cuối, hoạt động gần đây và danh sách module).

- Mọi chỉ số và trạng thái đều được tính từ `GET /api/snapshot`, cập nhật bằng SSE `/api/events`; không polling Peer bằng message. `Delivery.eventMessageIds` lưu event batch đầu vào Lead; không đưa toàn bộ App chat history vào Codex turn.
- `Idle` biểu thị Codex session không chạy turn; không đồng nghĩa task đã hoàn thành. Trạng thái task `finished` chỉ được tạo bởi `finish()`.
- Bảng sự kiện gần đây chỉ tổng hợp từ message đã lưu; chưa có progress stream hoặc event audit log chuyên dụng. Chỉ báo kết nối Backend qua SSE, không suy ra tình trạng Codex từ kết nối đó.
- `Xem luồng điều phối` hiển thị message routing (Lead ↔ Discovery và Lead ↔ Peer) dưới dạng các dòng mở rộng được. Agent Monitor hiển thị yêu cầu Lead giao Discovery và báo cáo gửi lại.
- `App Settings` có model/effort riêng cho Lead, Discovery và Peer.
- Layout responsive ở màn hình nhỏ: sidebar dạng dải task ngang, Agent Monitor nằm dưới hội thoại.

## Hiển thị Markdown từ Codex

Các message Lead, Peer và System được Web render bằng `react-markdown` và `remark-gfm`
(heading, danh sách, bảng, code block, liên kết). Backend tiếp tục lưu nguyên văn `Message.text`;
không rewrite, ép format hoặc tóm tắt phản hồi Codex.

Báo cáo dài được thu gọn theo **chiều cao phần nội dung đã render**, không cắt chuỗi Markdown.
`Xem toàn bộ` / `Thu gọn` chỉ thay đổi trạng thái hiển thị. Raw HTML không được thực thi;
link dùng kiểm tra URL mặc định của renderer và mở an toàn, hình ảnh remote không tự tải.

## App Settings: model và reasoning effort

Mở **App Settings · Model / Effort** ở thanh bên để đặt cấu hình riêng cho Lead, Discovery và Peer. UI lấy model và effort gợi ý từ Codex `model/list` qua `GET /api/models`. Khi catalog không khả dụng, người dùng vẫn có thể nhập model ID thủ công. Trường rỗng kế thừa cấu hình mặc định của Codex.

Settings lưu bền trong SQLite qua `PUT /api/settings` và được đưa vào `GET /api/snapshot`. **Lead defaults** áp dụng mỗi lượt Lead tiếp theo, kể cả Thread đang tồn tại. **Discovery defaults** áp dụng khi Discovery bắt đầu turn mới (không khởi động lại Discovery đang chạy). **Peer defaults** được chốt khi `assign_module` tạo Peer của module lần đầu; Peer đã tồn tại không thay đổi theo Settings mới.

Lead có thể override `model` và `effort` khi `assign_module` tạo Peer lần đầu; các lần giao sau cho cùng module giữ lựa chọn cũ. Thứ tự cho từng trường độc lập: `assign_module override → Peer App Settings → Codex default`. Codex kiểm tra model/effort có được hỗ trợ hay không; app không tự tạo model IDs hoặc đánh giá chất lượng đầu ra.

Runtime truyền `model` trong `thread/start` và `model`/`effort` trong `turn/start`.

## Lead là bộ não; ba agent có context độc lập

- **Lead** hiểu yêu cầu qua `NEW_EVENTS` và Codex Thread của chính mình, nắm tiêu chí hoàn thành, quản lý điều đã biết/chưa biết, phân tích dependency, giao Discovery/Peer và xử lý blocker. Lead cập nhật `Task Brief` bằng `update_task_brief(brief)`: `goal`, `acceptanceCriteria`, `verified` (kèm `evidenceRefs`), `preliminary`, `unknowns`, `nextDecision`. App chỉ lưu đánh giá của Lead, không chứng thực kết luận hay tạo quality gate.
- **Discovery** khám phá sơ bộ đúng phạm vi. Báo cáo của Discovery là `discovery-preliminary`, cần Peer kiểm tra khi quyết định phụ thuộc implementation cụ thể.
- **Peer** điều tra source chi tiết, sửa phần còn thiếu, báo cáo file, kết quả và bằng chứng; phân biệt build, HTTP integration, browser E2E. Lead chỉ định trách nhiệm kiểm chứng tích hợp khi giao việc đa module.
- Mỗi `assign_module`/`spawn_discovery`/`send_discovery` cần `message` tự đầy đủ và `expectedResult`, có thể chọn `contextRefs` (tối đa 8 message IDs từ cùng conversation). App snapshot nguyên văn yêu cầu gốc, Task Brief và các source được chọn thành **Context Packet** lưu cùng message trong SQLite, rồi chuyển cho worker trong prompt. Với Peer, packet có thêm các quyết định hiện hành ảnh hưởng module (`record_decision`). Không tự gửi toàn bộ Lead/Discovery Thread.
- `NEW_EVENTS` của Lead chứa message IDs mới đến trong lượt; các event trước nằm trong Codex Thread của Lead. Nếu Lead nói “dựa trên Discovery” hoặc dựa trên kết quả một Peer, phải đính kèm message ID liên quan trong `contextRefs`; người nhận không tự biết nội dung đó.
- UI **Xem luồng điều phối** và Agent Monitor cho phép xem đúng Context Packet đã gửi, gồm nguồn, nhãn `discovery-preliminary`/`peer-report` và `expectedResult`. Không tái tạo context từ lịch sử mới hơn.
- Lead không giao triển khai các phần phụ thuộc contract chưa xác minh; có thể chạy song song các việc thực sự độc lập. Trước `finish()`, Lead đối chiếu kết quả Peer với tiêu chí và nêu giới hạn test chưa thực hiện.
- Quy tắc vận hành agent nằm trong `instructions/<role>.md` (`lead`, `discovery`, `peer`), đọc lại mỗi turn; không có file thì vai trò đó không có quy tắc. Toàn bộ nội dung file được gửi nguyên văn cho agent; quy tắc code, test và conventions tùy chỉnh thuộc `AGENTS.md` của workspace/module. `workspace.local.json` chỉ nhận `lead.cwd`, `discovery.cwd/enabled` và danh sách module; model/effort thuộc App Settings.

## Discovery: Lead chủ động giao khảo sát sơ bộ

- Cấu hình `discovery.cwd` riêng và `discovery.enabled: true` trong `config/workspace.local.json`. Nếu thiếu hoặc tắt, Lead tiếp tục điều phối Peer trực tiếp. Discovery không tự khởi chạy.
- Khi tạo conversation, **Lead luôn nhận delivery đầu tiên**. Lead chủ động dùng `spawn_discovery(message)` khi cần hiểu tổng quan các module. Chỉ có **một Discovery Session mỗi conversation**, có thể giao khảo sát bổ sung bằng `send_discovery(sessionId,message)` trong cùng Codex Thread; không hỏi tiến độ.
- **Discovery là một giai đoạn bắt buộc phải hoàn thành nếu đã được chọn:** sau `spawn_discovery` hoặc `send_discovery` thành công, Lead phải kết thúc turn ngay. Store từ chối các tool Peer/`finish()` tiếp theo trong cùng Lead turn, đồng thời không bắt đầu Lead turn khác khi Discovery còn `queued/running`. Chỉ event báo cáo/lỗi Discovery mới cho phép Lead tiếp tục. Một Lead turn đã giao Peer cũng không được giao Discovery trong cùng turn.
- Discovery có `cwd` riêng và truy cập nhiều module qua `thread/start.runtimeWorkspaceRoots: [discovery.cwd, ...module paths]`. Đây là cách app-server mở thêm các thư mục, tương ứng mục tiêu CLI `--add-dir`. Không dùng `readOnly.access`, named permission profile hay hạn chế sandbox riêng.
- Discovery dùng **cùng sandbox và approval policy với Peer**: mặc định `danger-full-access`/`never`; `CODEX_SECURITY_MODE=sandbox` dùng `workspace-write`/`on-request`, với `writableRoots` gồm Discovery cwd và các module. Quy tắc *chỉ khám phá sơ bộ, không triển khai hoặc điều tra root cause* là instruction về vai trò, **không phải giới hạn runtime**. Cấu hình module phải được người dùng tin cậy.
- Model/effort của Discovery được chỉnh riêng trong **App Settings · Model & Effort** (SQLite), để trống dùng Codex default.
- Báo cáo kết quả/lỗi Discovery được lưu riêng và đánh thức Lead qua event. Lead chỉ dùng báo cáo định hướng; điều tra source, xác minh root cause và triển khai chuyên sâu vẫn do Peer thực hiện. Discovery không có dynamic routing tools.
- Discovery bị lỗi hoặc backend restart khi turn đang chạy sẽ tạo cảnh báo cho Lead; không replay turn, không poll. Báo cáo muộn sau `finish()` được lưu nhưng không đánh thức Lead.

## Lifecycle theo sự kiện

1. Người dùng tạo task. App tạo **Lead delivery**. Discovery chưa tự chạy.
2. Lead quyết định cần khám phá không. Nếu cần, gọi `spawn_discovery(message)` **trước khi giao Peer**, sau đó **kết thúc turn ngay**. App không cho kết hợp Discovery và Peer trong một turn. Nếu không, giao việc trực tiếp cho Peer.
3. Discovery thực hiện khảo sát sơ bộ nhiều module trong session riêng; trả báo cáo hoặc lỗi về Lead bằng event. Trong lúc Discovery pending, message người dùng vẫn được lưu nhưng không kích hoạt Lead sớm. `send_discovery(sessionId,message)` chỉ có thể tạo một giai đoạn khảo sát mới trong Lead turn sau khi báo cáo trước đã về.
4. Lead nhận báo cáo Discovery, yêu cầu Peer khảo sát sâu khi thiếu bằng chứng hoặc ghi quyết định chung bằng `record_decision` rồi giao `assign_module` cho từng module để triển khai. Peer report hoặc lỗi tiếp tục đánh thức Lead theo cơ chế event-driven.
5. Khi toàn task xong, Lead gọi `finish()` rồi trả Codex `finalText` bình thường. Task chuyển `finished`, queued deliveries bị `superseded`; báo cáo muộn không đánh thức Lead.
6. Người dùng gửi message mới có thể mở lại conversation `finished` và đánh thức Lead; Discovery không tự chạy lại.

## Điều phối và giao thức

- Chỉ Lead có Codex dynamic tools: `update_task_brief`, `record_decision`, `spawn_discovery`, `send_discovery`, `assign_module`, `finish`. Không dùng JSON envelope, `outputSchema` hoặc parser tự chế.
- Codex CLI không hỗ trợ dynamic tools sẽ trả lỗi; cần cập nhật Codex CLI và tạo conversation mới để nạp tool registry hiện tại.
- Tool call được lưu SQLite atomically kèm `callId`, chống xử lý lặp cùng lời gọi.
- Discovery và Peer không có routing tools. Discovery có session/cwd riêng và cùng quyền thực thi với Peer nhưng thêm nhiều module qua `runtimeWorkspaceRoots`. Peer thực thi trong module riêng, không giao tiếp Peer-to-Peer.
- Nhiều Peer có thể chạy trong cùng module, không có Git worktree hay tự động xử lý conflict.

## Recovery và timeout

- **Không còn timeout cứng 10 phút cho Codex turn.** App chờ terminal event từ Codex hoặc process exit.
- RPC request như `thread/start` vẫn có timeout kết nối riêng; đó không phải timeout thực thi task.
- Sau restart, delivery đang chạy thành `interrupted`, không tự replay. Discovery bị gián đoạn sẽ đánh thức Lead bằng thông báo lỗi; delivery chưa chạy vẫn ở queue.
- SQLite nằm tại `APP_DATA_DIR/coordination.sqlite` (mặc định `.data/coordination.sqlite`). Snapshot không có bước migrate dữ liệu cũ; khi schema đổi, dùng `APP_DATA_DIR` mới.
- **Watchdog định kỳ 15 phút chưa triển khai.** Peer bị treo khi process còn sống nhưng không gửi terminal event có thể chờ vô hạn cho đến khi được xử lý thủ công.

## API local

- `GET /api/health` — trạng thái Backend.
- `GET /api/snapshot` — conversations (Task Brief của Lead), sessions, messages (bao gồm Context Packet), deliveries, modules và settings.
- `GET /api/models` — model/effort catalog do Codex app-server cung cấp.
- `PUT /api/settings` — lưu `{"lead":{"model":"MODEL_ID","effort":"high"},"discovery":{"model":"MODEL_ID","effort":"low"},"peer":{"model":"MODEL_ID","effort":"medium"}}`. Dùng `""` để kế thừa Codex default.
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

**Bảo mật:** Lead chỉ ghi trong `lead.cwd` (`workspace-write`), không đọc/chạy trong module theo chỉ dẫn; Discovery và Peer mặc định `approvalPolicy: never` và `danger-full-access` (Discovery truy cập nhiều module). Backend không có authentication và chỉ bind localhost. Không expose lên Internet.
