# AI Agent Control Center

Dashboard **cá nhân, chạy trên máy local** để thay thế việc quản lý nhiều terminal Codex. Mục tiêu là giữ nguyên mô hình làm việc hiện có: **Lead Agent trong workspace chung → giao việc cho Peer ở các source module bên ngoài → nhận kết quả → Lead review / yêu cầu sửa → người dùng quyết định**.

> Trạng thái: P2 **Isolation & Recovery** trên nhánh tính năng. Codex **YOLO mode** vẫn là mặc định theo lựa chọn P1; có tùy chọn bật sandbox. Chưa phải production hoặc E2E verified trên máy người dùng.

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

Nhánh này dùng `approvalPolicy: "never"` và `sandbox: "danger-full-access"` / `sandboxPolicy.type: "dangerFullAccess"` cho mọi Thread và Turn. Tương đương `codex --yolo`. **Codex không hỏi cấp quyền từng lệnh, có quyền filesystem/network theo tài khoản chạy Backend**, kể cả bên ngoài source module; `cwd` chỉ định tuyến công việc chứ không chặn truy cập. Hãy sao lưu/commit các source modules và chỉ chạy với workspace tin cậy. Backend chưa có authentication và chỉ bind `127.0.0.1`.

**Business Approval** ở cuối workflow vẫn cần bạn bấm duyệt; khác với Runtime Approval vốn đã bỏ qua trong YOLO mode.

## Nhật ký hoạt động dễ đọc

Dashboard mặc định hiển thị **Activity Timeline** (Lead/Peer, thời gian, hành động, trạng thái, nội dung). Token stream `item/agentMessage/delta` được gom theo `itemId` thành một message; `commandExecution`, `fileChange` và các sự kiện Workflow có nhãn dễ hiểu. Chế độ **Kỹ thuật** vẫn cho xem event JSON khi debug; raw token delta không còn được lưu từng mẩu. Backend lưu timeline trong `.data/state.json`, có migration từ event journal cũ và giới hạn lịch sử. Streaming được flush định kỳ 250ms để tránh ghi đĩa/liên tục gọi SSE từng token.

## Final Integration Review + Acceptance Criteria

Sau khi tất cả Peer được Lead accept, Workflow **chưa** tự chuyển sang Business Approval: Lead chạy Final Integration Review, đối chiếu `acceptanceCriteria` của kế hoạch, kiểm tra việc kết nối giữa source modules và kết quả test/evidence. Final reviewer trả `pass`, `rework` hoặc `manual_verification`. Khi `rework`, Backend dispatch Peer được chỉ định và invalidate các Peer phụ thuộc upstream đã thay đổi. Khi `manual_verification`, UI hiển thị từng tiêu chí chưa được xác minh để người dùng tự kiểm tra và xác nhận, trước khi duyệt kết quả cuối.

Không có claim rằng test/browser đã được chạy nếu không có bằng chứng; review của LLM không thay thế E2E tự động. Xem `docs/WORKFLOW_P1.md`.

## Integration Contracts (thuộc Final Integration Review)

Mỗi dependency xuyên module trong LeadPlan phải được phân loại: **integrationContracts** (có artifact/API được bàn giao, nơi sử dụng và cách kiểm chứng) hoặc **orderingOnlyDependencies** (chỉ yêu cầu thứ tự, có lý do). Một dependency không đồng nghĩa với tích hợp; tuy nhiên Lead không được tự lờ đi một contract đã cam kết.

Final Integration Review duy nhất đánh giá đồng thời **Product Acceptance** (`checks`) và **Integration Acceptance** (`contractChecks`), đều có evidence. PASS chỉ khi cả hai nhóm đều passed. Nếu UI chạy bằng mock/fallback trong khi plan cam kết Web dùng API, reviewer phải đánh dấu contract failed và yêu cầu rework; nếu chưa kiểm chứng, yêu cầu người dùng xác nhận contract trước Business Approval. Đây vẫn là review dựa vào bằng chứng do Agent báo cáo, không đảm bảo chứng thực kỹ thuật độc lập.

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
