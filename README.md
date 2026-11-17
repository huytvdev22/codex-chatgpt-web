# Codex M365 Copilot

> **Phiên bản hiện tại:** `6.10.5`
>
> **Runtime:** Bun `1.4.0`
>
> **Desktop Launcher:** Electron `42`, React `19`, Vite `6`
>
> **Nền tảng đóng gói:** Windows x64, macOS 13+ và Linux x64

Codex M365 Copilot là một bridge cục bộ giúp Codex Desktop hoặc Codex CLI (và các client tương thích OpenAI Responses API) sử dụng mô hình **Microsoft 365 Copilot** thông qua giao diện Web. Dự án cung cấp một Responses API trên loopback, định tuyến toàn bộ request hợp lệ tới M365 Copilot Web Adapter (`src/adapters/m365-copilot/`).

## Kiến trúc

### Khi chạy thực tế, ứng dụng gồm 3 phần

Khi khởi chạy đầy đủ qua Electron Launcher, hệ thống gồm **3 phần chạy song song** (cộng thêm **Codex CLI / Desktop** ở ngoài gọi vào):

```text
[Codex CLI / Desktop]  (ứng dụng ngoài, gọi HTTP tới 127.0.0.1:17841)
         │
         ▼
1. [Local Responses API Server]  (Process Bun/Node: src/server.ts)
         │  ▲
         │  └── HTTP Control + Bearer Token (mượn tab, heartbeat)
         ▼
2. [Electron Launcher & Supervisor] (Process Electron: launcher/electron/main.cjs)
         │  ├── Giao diện React UI (launcher/src/)
         │  ├── RuntimeSupervisor (spawn & giám sát server)
         │  └── BrowserControlServer (control-server.cjs)
         ▼
3. [Embedded Browser Host] (Chromium WebContentsView trong Electron: browser-host.cjs)
         └── Mở sẵn tab M365 Copilot (giữ cookie đăng nhập)
             & cho phép Playwright kết nối vào qua CDP để gõ/đọc kết quả
```

1. **Local Responses API Server (`src/server.ts`, `src/controllers/`, `src/services/`):** Tiến trình backend (Bun/Node) lắng nghe trên `127.0.0.1:17841`, định tuyến request qua các Controller vào `ResponsesService`, phân giải model qua `ModelRegistry` → `AdapterRegistry` và chạy `WebTurnEngine` + `bridgeToResponsesSSE()`.
2. **Electron Launcher (`launcher/electron/`, `launcher/src/`):** App desktop quản lý vòng đời (tự bật/tắt server qua `RuntimeSupervisor`), hiển thị giao diện cài đặt/trạng thái và chạy `BrowserControlServer` để điều phối lượt dùng trình duyệt.
3. **Embedded Browser Host (`launcher/electron/browser-host.cjs`):** Trình duyệt Chromium nhúng ngay trong Electron, giữ session đăng nhập `m365.cloud.microsoft`, để `WebTurnEngine` dùng Playwright thao tác trực tiếp.

*(Nếu chạy CLI thuần bằng `bun run start` không qua Launcher, hệ thống chỉ chạy **Phần 1** và tự dùng `LocalBrowserRuntime` mở trình duyệt Playwright riêng khi có request.)*

### Cơ chế hoạt động theo 6 tầng (Architecture Layers)

Hệ thống hoạt động như một **Local API Gateway + Browser Orchestration Engine** trên loopback (`127.0.0.1:17841`), chia thành 6 tầng rõ rệt:

1. **Tầng Entrypoint & Lifecycle (`src/cli.ts`, `src/setup.ts`, `src/service.ts`):**
   - `setup` / `route`: Ghi `openai_base_url = "http://127.0.0.1:17841/v1"` vào `~/.codex/config.toml` (qua `src/codex-integration.ts`) để điều hướng toàn bộ request của Codex CLI/Desktop về local server.
   - `serve` / `service`: Khởi chạy và quản lý tiến trình daemon server nền.
   - `doctor`: Kiểm tra sức khỏe toàn hệ thống.

2. **Tầng Web Router & Controller (`src/server.ts`, `src/controllers/`):**
   - `src/server.ts` đóng vai trò **Front Controller / Router** mỏng: mở HTTP server qua `serveUniversal()` (`src/controllers/universal-http-server.ts`), áp dụng CORS loopback, theo dõi vòng đời HTTP stream bằng `HttpTurnCounter` (`src/controllers/http-turn-counter.ts`) và điều phối request vào 3 Controller:
     - `ModelsController` (`src/controllers/models-controller.ts`): `GET /v1/models` (đồng bộ catalog, `ETag`, metrics).
     - `ResponsesController` (`src/controllers/responses-controller.ts`): `POST /v1/responses`, `POST /v1/responses/compact`, `GET /v1/responses` (426).
     - `AdminController` (`src/controllers/admin-controller.ts`): `GET /docs`, `GET /healthz`, `POST /admin/drain`, `/admin/resume`, `/admin/cancel-turn`, `/admin/interrupt-turn`, `/admin/cancel-turns`, `/admin/shutdown`.

3. **Tầng Service & Registry (`src/services/responses-service.ts`, `src/models/`, `src/adapters/adapter-registry.ts`, `src/responses/`):**
   - `ResponsesService` xử lý toàn bộ nghiệp vụ cho `/v1/responses` và `/v1/responses/compact`: khôi phục ngữ cảnh (`src/responses/state.ts`), parse request (`src/responses/parser.ts`), chạy `adapter.runTurn()` và đẩy kết quả qua `bridgeToResponsesSSE()` / `buildResponseJSON()`.
   - Phân giải động theo đa hình: `ModelRegistry.getInstance().findProvider(model)` (`src/models/model-registry.ts`) xác định `providerId`, sau đó `AdapterRegistry.getInstance().createAdapter(providerId)` (`src/adapters/adapter-registry.ts`) khởi tạo `ProviderAdapter` tương ứng mà tầng HTTP không cần biết adapter cụ thể nào. Model không hợp lệ bị từ chối với HTTP `400 invalid_request_error` kèm danh sách provider đang bật động.

4. **Tầng Core Engine: `WebTurnEngine` (`src/adapters/web/engine.ts`):**
   - Áp dụng **Template Method / Strategy Pattern**: `m365-copilot` khai báo cấu hình `WebProviderDefinition`, còn toàn bộ vòng đời xử lý nằm trong `WebTurnEngine.runTurn()`:
     - Đăng ký lượt chạy vào `activeWebTurnRegistry` để hỗ trợ hủy/ngắt (`cancel`/`interrupt`) giữa chừng.
     - Mượn `Page` Playwright từ trình duyệt nhúng của Electron Launcher (hoặc `LocalBrowserRuntime`) qua `acquireWebTurnSurface()` (`src/adapters/web/runtime-lifecycle.ts`).
     - Biên dịch lịch sử chat + JSON schema của tools thành prompt văn bản kèm quy tắc định dạng (`compileWebPrompt()`).
     - Gọi `definition.browser.executeTurn()` (`m365-browser-worker.ts`) để gửi prompt lên giao diện Web và đọc raw text trả về.
     - Chuẩn hóa qua `parseStrictWebResponse()` & `validateWebProtocolResponse()`. Nếu AI trả lời sai format, `runWebProtocolRetry()` tự động gửi prompt nhắc sửa lỗi và thử lại (mặc định tối đa `maxFormatRetries = 2` lần).
     - Kiểm tra chống lặp tool vô hạn (`src/adapters/web/execution/turn-guard.ts`) trước khi phát ra `AdapterEvent`.

5. **Tầng Serialization / Streaming (`src/bridge.ts`):**
   - `bridgeToResponsesSSE()` nhận `AsyncIterable<AdapterEvent>` từ `WebTurnEngine` và chuyển đổi thành **Server-Sent Events (SSE)** chuẩn OpenAI Responses API trả về cho Codex theo thời gian thực.
   - Hỗ trợ streaming text, tool call, `apply_patch` (freeform tool), `tool_search_call`, `collaboration` (multi-agent `spawn_agent`, `send_message`), nén ngữ cảnh `compaction` (`ocx1:` + base64), heartbeat (`2_000ms`) và stall timeout.

6. **Electron Launcher (`launcher/electron/`, `launcher/src/`):**
   - Đóng vai trò **Desktop Process Supervisor + Embedded Browser Host**.
   - Khởi chạy/giám sát tiến trình `server.ts`, mở tab trình duyệt nhúng M365 Copilot để người dùng đăng nhập sẵn session/cookie, rồi cấp quyền cho `WebTurnEngine` dùng Playwright tương tác thông qua cơ chế descriptor/lease và token bảo mật.

### Cấu trúc thư mục (Source Tree)

```text
codex-chatgpt-web/
├── src/
│   ├── cli.ts                        # Điểm vào CLI (setup, serve, doctor, route, service...)
│   ├── server.ts                     # Front Controller / Router mỏng & facade tương thích
│   ├── controllers/                  # Tầng HTTP Controller & tracking stream
│   │   ├── universal-http-server.ts  # Adapter HTTP thống nhất (Bun.serve / node:http) & CORS loopback
│   │   ├── http-turn-counter.ts      # HttpTurnCounter theo dõi & hủy HTTP/SSE streams
│   │   ├── models-controller.ts      # ModelsController (GET /v1/models)
│   │   ├── responses-controller.ts   # ResponsesController (POST /v1/responses, /compact)
│   │   └── admin-controller.ts       # AdminController (/docs, /healthz, /admin/*)
│   ├── services/
│   │   └── responses-service.ts      # ResponsesService điều phối turn, compaction & SSE/JSON bridge
│   ├── bridge.ts                     # Chuyển AdapterEvent -> Responses API SSE / JSON
│   ├── service.ts                    # Quản lý daemon service & điều khiển active turns
│   ├── setup.ts                      # Quy trình cài đặt runtime & browser host
│   ├── codex-integration*.ts         # Đọc/ghi an toàn ~/.codex/config.toml & integration journal
│   ├── models/
│   │   ├── base-model-provider.ts    # Abstract BaseModelProvider (Template Method cho model catalog)
│   │   ├── model-registry.ts         # Registry trung tâm quản lý các BaseModelProvider
│   │   └── model-catalog.ts          # Tạo và đồng bộ model catalog cục bộ cho Codex
│   ├── responses/
│   │   ├── parser.ts                 # Parse request chuẩn Responses API
│   │   ├── state.ts                  # Lưu/khôi phục continuation state (previous_response_id)
│   │   ├── compaction.ts             # Nén ngữ cảnh hội thoại (compact)
│   │   └── schema.ts                 # Schema định nghĩa dữ liệu Responses API
│   └── adapters/
│       ├── base.ts                   # Interface ProviderAdapter
│       ├── adapter-registry.ts       # AdapterRegistry map providerId -> ProviderAdapter factory
│       ├── web/                      # Shared Web Turn Engine dùng chung cho Web provider
│       │   ├── engine.ts             # WebTurnEngine (orchestrator chính)
│       │   ├── definition.ts         # Contract cấu hình WebProviderDefinition
│       │   ├── runtime-lifecycle.ts  # Mượn/trả browser surface & lease heartbeat
│       │   ├── browser/              # Browser helper entrypoint (browser-helper-main.ts)
│       │   ├── compile-prompt.ts     # Biên dịch prompt & tool instructions
│       │   ├── protocol/             # Parse, validate & retry giao thức phản hồi Web AI
│       │   ├── execution/            # Turn guard (chống lặp tool vô hạn)
│       │   └── tools/                # Cầu nối tool calls (WebToolBridge)
│       └── m365-copilot/             # Adapter cho Microsoft 365 Copilot (worker, attachments, picker)
├── launcher/
│   ├── electron/                     # Electron main process, browser host, control-server, supervisor
│   └── src/                          # Giao diện React (Vite) & preload contract
├── scripts/                          # Build bundle, verify, smoke tests, check circular deps
├── tests/                            # Unit & integration tests cho runtime
└── docs/                             # Tài liệu kiến trúc, bảo mật & troubleshooting
```
