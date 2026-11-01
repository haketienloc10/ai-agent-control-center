# AI Agent Control Center

Dashboard **cá nhân, chạy trên máy local** để thay thế việc quản lý nhiều terminal Codex. Mục tiêu là giữ nguyên mô hình làm việc hiện có: **Lead Agent trong workspace chung → giao việc cho Peer ở các source module bên ngoài → nhận kết quả → Lead review / yêu cầu sửa → người dùng quyết định**.

> Trạng thái: P3 **Experience & Observability** trên nhánh tính năng. Codex **YOLO mode** vẫn là mặc định theo lựa chọn P1; có tùy chọn bật sandbox. Chưa phải production hoặc E2E verified trên máy người dùng.

## Bắt đầu

Yêu cầu: Node.js >= 22, npm và Codex CLI đã cài, đăng nhập hợp lệ qua `codex login`.

```bash
npm install
cp config/workspace.example.json config/workspace.local.json
# Sửa lead.cwd và modules[].path thành các đường dẫn tuyệt đối có thật trên máy
npm run dev:api
# Trong terminal khác:
npm run dev:web
```

Mở http://localhost:5173; Backend mặc định http://127.0.0.1:4317. Tại Dashboard, chọn **Tạo & chạy Workflow** để Lead tự lập kế hoạch → Backend dispatch Peer → Lead review/rework → người dùng duyệt. Chức năng Task thủ công vẫn còn. Hệ thống tạo Codex thread ở `cwd` đã cấu hình, stream event lên UI và lưu trạng thái trong `.data/`.

Nếu chưa cài/đăng nhập Codex, API vẫn có thể khởi chạy nhưng **Run sẽ lỗi có thể quan sát được**. App chỉ dành cho localhost; không expose cổng trực tiếp ra Internet.

## Định hướng kỹ thuật

- `docs/GOALS.md`: mục tiêu, phạm vi, thành công và giới hạn.
- `docs/ARCHITECTURE.md`: module boundaries, data flow, lifecycle và security.
- `docs/ROADMAP.md`: các giai đoạn thực hiện, acceptance criteria.
- `docs/WORKFLOW_P1.md`: hợp đồng JSON, luồng triển khai P1, API, giới hạn.
- `docs/P2.md`: worktree, SQLite, artifact, recovery và security mode.
- `docs/P3.md`: bản đồ Agent, lịch sử session, notifications, journal và metrics.
- `AGENTS.md`: quy tắc dành cho contributor/Agent.
- `apps/api`: Backend, WorkflowEngine, Task Store, SessionManager và Codex JSON-RPC adapter.
- `apps/web`: Dashboard có timeline hoạt động dễ đọc và tab kỹ thuật, SSE, Run/Interrupt/Approval.
- `packages/contracts`: kiểu dữ liệu dùng chung.

## Kiểm tra

```bash
npm run typecheck
npm test
curl http://127.0.0.1:4317/api/health
```

Các lệnh trên là **cách kiểm chứng**, không phải kết quả kiểm thử đã được xác nhận trong repo.

Tài liệu giao thức: https://developers.openai.com/codex/app-server

## P1: Lead → Peer → Review

- POST `/api/workflows` với `{ "title": "...", "request": "..." }`: tự chạy Lead lập kế hoạch.
- Lead trả `LeadPlan` JSON: `summary`, `tasks[]` có `id`, `moduleId`, `dependsOn`, `instructions`.
- Backend validation module/dependency DAG, chạy tối đa 2 Peer cùng lúc và chỉ **1 Peer/module**.
- Peer trả `PeerResult` JSON gồm `summary`, `changedFiles`, `tests`, `risks`. Backend bổ sung `PeerEvidence`: Git status trước/sau, Git diff preview, kiểm tra artifact path và command execution events.
- Lead review từng batch, chọn `accept` / `rework`; tối đa 2 lần làm lại/Peer.
- Khi tất cả Peer được chấp nhận, workflow dừng tại `waiting_business_approval`; người dùng quyết định tại Dashboard.
- POST `/api/workflows/:id/decision` với `{ "decision": "approve" }` hoặc `reject`.

**Lưu ý:** P1 cho phép ghi trực tiếp vào source module ngoài repo. Sao lưu/commit code của bạn trước khi chạy, và dùng module riêng hoặc worktree thủ công nếu cần cách ly. Worktree tự động, xác minh test độc lập và resume an toàn nằm ở P2. P1 không tự merge.

## Codex YOLO mode (local-only)

Chỉ Peer mặc định chạy `approvalPolicy: "never"`, `sandbox: "danger-full-access"` và `sandboxPolicy.type: "dangerFullAccess"`, tương đương Codex YOLO. Lead và Final Reviewer dùng `read-only` để điều phối/kiểm tra. Có thể bật `CODEX_SECURITY_MODE=sandbox` cho Peer. **Git worktree không phải OS sandbox:** Peer ở YOLO vẫn có quyền filesystem/network theo tài khoản Backend; `cwd` chỉ định tuyến công việc. Chỉ chạy trên máy tin cậy; Backend không có authentication và bind `127.0.0.1`. 

**Business Approval** ở cuối workflow vẫn cần bạn bấm duyệt; khác với Runtime Approval vốn đã bỏ qua trong YOLO mode.

## Nhật ký hoạt động dễ đọc

Dashboard mặc định hiển thị **Activity Timeline** (Lead/Peer, thời gian, hành động, trạng thái, nội dung). Token stream `item/agentMessage/delta` được gom theo `itemId` thành một message; `commandExecution`, `fileChange` và các sự kiện Workflow có nhãn dễ hiểu. Chế độ **Kỹ thuật** vẫn cho xem event JSON khi debug; raw token delta không còn được lưu từng mẩu. Backend lưu timeline trong `.data/state.json`, có migration từ event journal cũ và giới hạn lịch sử. Streaming được flush định kỳ 250ms để tránh ghi đĩa/liên tục gọi SSE từng token.

## Final Integration Review + Acceptance Criteria

Sau khi tất cả Peer được Lead accept, một **Final Reviewer Agent riêng** mở Codex Thread mới, read-only, đối chiếu `acceptanceCriteria`, kết nối giữa các module và test evidence. Reviewer trả `pass`, `rework` hoặc `unverified`. Khi `rework`, **Lead** quyết định Peer nào sửa, Backend invalidates các downstream phụ thuộc. Khi `unverified`, **Lead** quyết định `collect_evidence`, `run_verification`, `request_human` hoặc `blocked`. Chỉ `request_human` mới mở Human Verification; Lead không được tự tuyên bố passed.

Không có claim rằng test/browser đã được chạy nếu không có bằng chứng; review của LLM không thay thế E2E tự động. Xem `docs/WORKFLOW_P1.md`.

## Integration Contracts (thuộc Final Integration Review)

Mỗi dependency xuyên module trong LeadPlan phải được phân loại: **integrationContracts** (có artifact/API được bàn giao, nơi sử dụng và cách kiểm chứng) hoặc **orderingOnlyDependencies** (chỉ yêu cầu thứ tự, có lý do). Một dependency không đồng nghĩa với tích hợp; tuy nhiên Lead không được tự lờ đi một contract đã cam kết.

Final Integration Review duy nhất đánh giá đồng thời **Product Acceptance** (`checks`) và **Integration Acceptance** (`contractChecks`), đều có evidence. PASS chỉ khi cả hai nhóm đều passed. Nếu UI chạy bằng mock/fallback trong khi plan cam kết Web dùng API, reviewer phải đánh dấu contract failed và yêu cầu rework; nếu chưa kiểm chứng, Reviewer báo `unverified` và Lead điều phối thu thập bằng chứng hoặc quyết định có cần Human Verification.  Đây vẫn là review dựa vào bằng chứng do Agent báo cáo, không đảm bảo chứng thực kỹ thuật độc lập.

## P2 — Worktree, SQLite, Recovery và Artifact Viewer

Peer phải chạy trong Git repository có ít nhất 1 commit và working tree sạch. P2 tạo detached worktree riêng cho workflow, theo từng Git repo. Nếu hai module cùng Git repository, chúng dùng chung worktree trong một workflow và được serialize khi ghi.

- File thay đổi của Peer không tự ghi vào source repo; Dashboard hiển thị patch và nút tải artifact. P2 **không tự merge**.
- Trạng thái được lưu trong `.data/state.sqlite` (WAL); `.data/state.json` được giữ làm mirror tương thích dữ liệu cũ. Backend có event journal phân trang.
- Khi restart, Task đang chạy thành `interrupted`; Codex Thread được đối chiếu read-only. Không có hành vi retry tác vụ cũ tự động.
- Module có thể cấu hình `testCommand`, ví dụ `["npm","test"]` trong `config/workspace.local.json`, để Backend kiểm thử riêng.
- `CODEX_SECURITY_MODE=sandbox npm run dev:api` để dùng sandbox cho Codex. Nếu không đặt, YOLO được giữ lại và không thể coi là cô lập quyền truy cập file/network.

Xem [docs/P2.md](docs/P2.md) để biết quy trình áp dụng patch thủ công và các giới hạn bảo mật.

## Agent roles — Independent Final Reviewer

Lead chỉ điều phối Peer và ra quyết định accept/rework hoặc khắc phục blocker; không tự làm Final Integration Review. Sau các Peer được Lead chấp nhận, một **Final Reviewer riêng** (`role=reviewer`) kiểm tra Product + Integration Acceptance trên **Codex Thread mới, read-only**. Nếu có failed findings, Lead nhận báo cáo và quyết định Peer cần sửa. Mỗi lần review lại sau rework tạo một Thread mới. Xem [docs/AGENT_ROLES.md](docs/AGENT_ROLES.md).

## P3 — Trải nghiệm điều phối và quan sát

Dashboard có **Agent Map dạng 2.5D** (Lead, Peer theo module, Final Reviewer), hiển thị trạng thái thực từ Task trong workflow; chọn Agent để xem session tương ứng. **Session History** lọc theo role/status/workflow và tải trang cũ hơn theo cursor. **Activity Timeline** có thêm bộ lọc từ khóa/trạng thái/thời gian và một **Event Journal Explorer** đọc từ SQLite, không phụ thuộc cửa sổ timeline giới hạn.

Backend tạo **notification** khi Task thất bại/gián đoạn hoặc Workflow chuyển trạng thái cần người dùng xử lý. Thông báo được lưu qua restart và có nút đánh dấu đã đọc. Dashboard polling `/api/metrics` mỗi 8 giây để hiển thị bộ nhớ RSS/heap, CPU time tích lũy và uptime của **tiến trình Backend** cùng các bộ đếm Task/Workflow. Không suy diễn CPU/RAM riêng của Codex/Agent.

Các API mới: `GET /api/sessions`, `GET /api/journal/history`, `GET /api/notifications`, `POST /api/notifications/:id/read`, `GET /api/metrics`. Claude Code Adapter đang là tùy chọn, chưa triển khai vì workflow hiện sử dụng Codex CLI subscription. Xem [docs/P3.md](docs/P3.md).
