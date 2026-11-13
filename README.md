# Codex M365 Copilot

> **Phiên bản hiện tại:** `6.9.6`
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

1. **Local Responses API Server (`src/server.ts`):** Tiến trình backend (Bun/Node) lắng nghe trên `127.0.0.1:17841`, nhận request từ Codex/client, kiểm tra model `m365-copilot` và chạy `WebTurnEngine` + `bridgeToResponsesSSE()`.
2. **Electron Launcher (`launcher/electron/`, `launcher/src/`):** App desktop quản lý vòng đời (tự bật/tắt server qua `RuntimeSupervisor`), hiển thị giao diện cài đặt/trạng thái và chạy `BrowserControlServer` để điều phối lượt dùng trình duyệt.
3. **Embedded Browser Host (`launcher/electron/browser-host.cjs`):** Trình duyệt Chromium nhúng ngay trong Electron, giữ session đăng nhập `m365.cloud.microsoft`, để `WebTurnEngine` dùng Playwright thao tác trực tiếp.

*(Nếu chạy CLI thuần bằng `bun run start` không qua Launcher, hệ thống chỉ chạy **Phần 1** và tự dùng `LocalBrowserRuntime` mở trình duyệt Playwright riêng khi có request.)*

### Cơ chế hoạt động theo 6 tầng (Architecture Layers)

Hệ thống hoạt động như một **Local API Gateway + Browser Orchestration Engine** trên loopback (`127.0.0.1:17841`), chia thành 6 tầng rõ rệt:

1. **Tầng Entrypoint & Lifecycle (`src/cli.ts`, `src/setup.ts`, `src/service.ts`):**
   - `setup` / `route`: Ghi `openai_base_url = "http://127.0.0.1:17841/v1"` vào `~/.codex/config.toml` (qua `src/codex-integration.ts`) để điều hướng toàn bộ request của Codex CLI/Desktop về local server.
   - `serve` / `service`: Khởi chạy và quản lý tiến trình daemon server nền.
   - `doctor`: Kiểm tra sức khỏe toàn hệ thống.

2. **Tầng Web / Controller (`src/server.ts`):**
   - Hàm `serveUniversal()` mở HTTP server (ưu tiên `Bun.serve`, fallback sang `node:http`), lắng nghe 2 nhóm endpoint:
     - **OpenAI-compatible API:** `GET /v1/models`, `POST /v1/responses`, `POST /v1/responses/compact`, `GET /docs`.
     - **Admin / Control Endpoints:** `GET /healthz`, `POST /admin/drain`, `POST /admin/resume`, `POST /admin/cancel-turn`, `POST /admin/interrupt-turn`, `POST /admin/shutdown`.

3. **Tầng Routing & Service (`src/models/model-registry.ts`, `src/responses/`):**
   - Khi nhận `POST /v1/responses`, request JSON được parse bởi `src/responses/parser.ts` và khôi phục ngữ cảnh (nếu có `previous_response_id`) qua `src/responses/state.ts`.
   - `isProviderModel(model, "m365-copilot")` kiểm tra và định tuyến các model `m365-copilot` (`m365-copilot/...`) tới `createM365CopilotAdapter()` (`src/adapters/m365-copilot/`). Model khác sẽ bị từ chối với HTTP `400 invalid_request_error`.

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
│   ├── server.ts                     # HTTP server (Bun.serve / node:http), routing & /admin/*
│   ├── bridge.ts                     # Chuyển AdapterEvent -> Responses API SSE / JSON
│   ├── service.ts                    # Quản lý daemon service & điều khiển active turns
│   ├── setup.ts                      # Quy trình cài đặt runtime & browser host
│   ├── codex-integration*.ts         # Đọc/ghi an toàn ~/.codex/config.toml & integration journal
│   ├── models/
│   │   ├── model-registry.ts         # Khai báo Web provider m365-copilot & routes
│   │   └── model-catalog.ts          # Tạo và đồng bộ model catalog cục bộ cho Codex
│   ├── responses/
│   │   ├── parser.ts                 # Parse request chuẩn Responses API
│   │   ├── state.ts                  # Lưu/khôi phục continuation state (previous_response_id)
│   │   ├── compaction.ts             # Nén ngữ cảnh hội thoại (compact)
│   │   └── schema.ts                 # Schema định nghĩa dữ liệu Responses API
│   └── adapters/
│       ├── base.ts                   # Interface ProviderAdapter
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
