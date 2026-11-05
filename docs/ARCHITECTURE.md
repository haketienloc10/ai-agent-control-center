# Kiến trúc Event-driven Discovery → Lead ↔ Peer

```mermaid
sequenceDiagram
  actor User
  participant Store as SQLite / Coordinator
  participant Discovery as Discovery Codex turn
  participant Lead as Lead Codex turn
  participant Peer as Peer Codex turn
  User->>Store: Tạo task hoặc gửi message
  opt Task mới cần khám phá
    Store->>Discovery: Discovery delivery
    Discovery-->>Store: Báo cáo sơ bộ hoặc lỗi
    Store->>Lead: Discovery event
  end
  Store->>Lead: Lead delivery (trực tiếp nếu không cần Discovery)
  Lead->>Store: spawn_peer / send_peer
  Store-->>Lead: Tool result
  Lead-->>Store: turn/completed; Lead idle
  Store->>Peer: Peer delivery
  Note over Lead: Không giữ turn để chờ Peer
  Peer-->>Store: turn/completed hoặc lỗi
  Store->>Lead: Peer event nếu task active
  Lead->>Store: finish() khi toàn task xong
  Store-->>Lead: Tool success
  Lead-->>Store: Codex finalText báo cáo cuối
  Store-->>User: finished + báo cáo cuối
```

## Trách nhiệm

- `apps/api/src/index.ts`: API HTTP/SSE chỉ localhost.
- `apps/api/src/coordination-store.ts`: SQLite transaction, Discovery gate đầu conversation, kết quả Discovery/Peer đánh thức Lead, routing idempotent, `finish` chặn delivery cũ.
- `apps/api/src/coordinator.ts`: scheduler theo `store.on('change')`, tối đa một turn/session và tối đa bốn turn đồng thời. Discovery và Peer chạy session riêng. Không polling.
- `apps/api/src/codex-runtime.ts`: transport `thread/start`, `thread/resume`, `turn/start`, terminal notifications, `item/tool/call`.
- `apps/web/src/main.tsx`: giao diện conversation, trạng thái Peer, transcript.

## Vòng đời

- Task: `active | finished`. Kết thúc Lead turn không có nghĩa là kết thúc task.
- Session: `idle | running | interrupted`. Lead idle có thể đang chờ Peer.
- Delivery: `queued | running | completed | interrupted | superseded`.
- `completeDiscovery()` lưu báo cáo sơ bộ riêng và tạo một Lead wake-up. Nếu lỗi/restart, Lead nhận cảnh báo và không bị kẹt. User gửi message trong khi Discovery đang chạy cũng không khởi động Lead sớm.
- `completePeer()` ghi nhận kết quả và tạo tối đa một Lead wake-up đang pending. Nếu task `finished`, báo cáo muộn được lưu nhưng không đánh thức Lead.
- `failDelivery()` thông báo lỗi Peer tới Lead chỉ khi task còn `active`.
- `finish()` chỉ chuyển task sang `finished` và supersede delivery chưa chạy, không ép dừng Peer đang chạy. Codex `finalText` từ turn gọi finish được lưu làm báo cáo cuối (nếu rỗng có fallback). Nếu turn lỗi sau finish, app hiển thị system message. Người dùng mới có thể chủ động mở lại task.

## Dynamic tools

Chỉ Lead có `spawn_peer`, `send_peer`, `finish` khi `thread/start.dynamicTools`. Discovery và Peer không có routing tools. Discovery có `cwd` riêng, sandbox `readOnly`, `access.restricted.readableRoots` gồm Discovery workspace và module paths. Không có JSON routing, `outputSchema` fallback hay parser cũ. `send_peer` dành cho instruction thật sự, không dùng hỏi tiến độ. Tool `callId` được lưu trước khi trả kết quả, chống replay.

## Recovery

Codex turn không có timer thực thi 10 phút. RPC có deadline riêng để phát hiện lỗi kết nối. Không có watchdog 15 phút trong bản này; Peer không phát terminal event nhưng process còn sống có thể chờ vô hạn.

SQLite giữ trạng thái sau restart; delivery đang chạy thành interrupted và không replay. Discovery interrupted tạo event lỗi để Lead tiếp tục. CI dùng fake Codex transport, không chứng minh E2E với Codex thật.

Lead read-only; Peer sửa source trực tiếp. Không có OS isolation khi YOLO, và nhiều Peer cùng module có thể ghi xung đột.

## Model/effort Settings trên event-driven lifecycle

- `Snapshot.settings` lưu `AppSettings.lead` và `AppSettings.peer`. `CoordinationStore.updateSettings()` xác thực trường transport rồi lưu vào SQLite. Snapshot PR #13 cũ được bổ sung settings mặc định khi mở.
- `GET /api/models` dùng `model/list` và phân trang để lấy model/effort hỗ trợ; UI vẫn cho nhập model ID khi catalog lỗi.
- `Coordinator.execute()` đọc Lead defaults **mỗi turn mới**. Peer dùng `session.model/effort` đã chốt khi spawn, không bị thay đổi khi App Settings cập nhật.
- `routeLeadTool(spawn_peer)` áp dụng thứ tự `override → Peer default → Codex default` cho từng trường độc lập. `send_peer` chỉ giao công việc, không hỏi trạng thái.
- `CodexAgentRuntime.run()` truyền model ở `thread/start` và model/effort ở `turn/start`. Dynamic tools là giao thức điều phối duy nhất. Không thêm legacy JSON parser, schema fallback, timer 10 phút hay status polling.
- Không thay đổi PR #13: task `generation`, `wakeLead`, `superseded`, `finish`, chống Peer result đến muộn vẫn có hiệu lực.
