# Codex M365 Copilot

> **Phiên bản hiện tại:** `6.9.6`
>
> **Runtime:** Bun `1.4.0`
>
> **Desktop Launcher:** Electron `42`, React `19`, Vite `6`
>
> **Nền tảng đóng gói:** Windows x64, macOS 13+ và Linux x64

Codex M365 Copilot là một bridge cục bộ giúp Codex Desktop hoặc Codex CLI sử dụng các mô hình AI thông qua giao diện Web. Dự án cung cấp một Responses API trên loopback, định tuyến request tới Web Adapter phù hợp hoặc chuyển tiếp request tới native Codex khi model không thuộc Web provider.

## Kiến trúc

### Cơ chế hoạt động theo 6 tầng (Architecture Layers)

Hệ thống hoạt động như một **Local API Gateway + Browser Orchestration Engine** trên loopback (`127.0.0.1:17841`), chia thành 6 tầng rõ rệt:

1. **Tầng Entrypoint & Lifecycle (`src/cli.ts`, `src/setup.ts`, `src/service.ts`):**
   - `setup` / `route`: Ghi `openai_base_url = "http://127.0.0.1:17841/v1"` vào `~/.codex/config.toml` (qua `src/codex-integration.ts`) để điều hướng toàn bộ request của Codex CLI/Desktop về local server.
   - `serve` / `service`: Khởi chạy và quản lý tiến trình daemon server nền.
   - `doctor`: Kiểm tra sức khỏe toàn hệ thống.

2. **Tầng Web / Controller (`src/server.ts`):**
   - Hàm `serveUniversal()` mở HTTP server (ưu tiên `Bun.serve`, fallback sang `node:http`), lắng nghe 2 nhóm endpoint:
     - **OpenAI-compatible API:** `GET /v1/models`, `POST /v1/responses`, `POST /v1/responses/compact`, `POST /v1/alpha/search`, `POST /v1/images/generations`, `POST /v1/images/edits`.
     - **Admin / Control Endpoints:** `GET /healthz`, `POST /admin/drain`, `POST /admin/resume`, `POST /admin/cancel-turn`, `POST /admin/interrupt-turn`, `POST /admin/shutdown`.

3. **Tầng Routing & Service (`src/models/model-registry.ts`, `src/responses/`, `src/native-passthrough.ts`):**
   - Khi nhận `POST /v1/responses`, request JSON được parse bởi `src/responses/parser.ts` và khôi phục ngữ cảnh (nếu có `previous_response_id`) qua `src/responses/state.ts`.
   - `requireModelRoute(parsed.modelId)` dựa vào model slug để định tuyến:
     - `chatgpt-web` → `createChatGptWebAdapter()` (`src/adapters/chatgpt-web/`).
     - `m365-copilot` (`m365-copilot/...`, `m365-...`) → `createM365CopilotAdapter()` (`src/adapters/m365-copilot/`).
     - Các model khác → forward thẳng qua `forwardNativeCodexRequest()` (`src/native-passthrough.ts`).

4. **Tầng Core Engine: `WebTurnEngine` (`src/adapters/web/engine.ts`):**
   - Áp dụng **Template Method / Strategy Pattern**: cả `chatgpt-web` và `m365-copilot` chỉ là cấu hình `WebProviderDefinition`, còn toàn bộ vòng đời xử lý nằm trong `WebTurnEngine.runTurn()`:
     - Đăng ký lượt chạy vào `activeWebTurnRegistry` để hỗ trợ hủy/ngắt (`cancel`/`interrupt`) giữa chừng.
     - Mượn `Page` Playwright từ trình duyệt nhúng của Electron Launcher (hoặc `LocalBrowserRuntime`) qua `acquireWebTurnSurface()` (`src/adapters/web/runtime-lifecycle.ts`).
     - Biên dịch lịch sử chat + JSON schema của tools thành prompt văn bản kèm quy tắc định dạng (`compileWebPrompt()`).
     - Gọi `definition.browser.executeTurn()` (`chatgpt-browser-worker.ts` / `m365-browser-worker.ts`) để gửi prompt lên giao diện Web và đọc raw text trả về.
     - Chuẩn hóa qua `parseStrictWebResponse()` & `validateWebProtocolResponse()`. Nếu AI trả lời sai format, `runWebProtocolRetry()` tự động gửi prompt nhắc sửa lỗi và thử lại (mặc định tối đa `maxFormatRetries = 2` lần).
     - Kiểm tra chống lặp tool vô hạn (`src/adapters/web/execution/turn-guard.ts`) trước khi phát ra `AdapterEvent`.

5. **Tầng Serialization / Streaming (`src/bridge.ts`):**
   - `bridgeToResponsesSSE()` nhận `AsyncIterable<AdapterEvent>` từ `WebTurnEngine` và chuyển đổi thành **Server-Sent Events (SSE)** chuẩn OpenAI Responses API trả về cho Codex theo thời gian thực.
   - Hỗ trợ streaming text, tool call, `apply_patch` (freeform tool), `tool_search_call`, `collaboration` (multi-agent `spawn_agent`, `send_message`), nén ngữ cảnh `compaction` (`ocx1:` + base64), heartbeat (`2_000ms`) và stall timeout.

6. **Electron Launcher (`launcher/electron/`, `launcher/src/`):**
   - Đóng vai trò **Desktop Process Supervisor + Embedded Browser Host**.
   - Khởi chạy/giám sát tiến trình `server.ts`, mở các tab trình duyệt nhúng (ChatGPT, M365 Copilot) để người dùng đăng nhập sẵn session/cookie, rồi cấp quyền cho `WebTurnEngine` dùng Playwright tương tác thông qua cơ chế descriptor/lease và token bảo mật.

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
│   ├── native-passthrough.ts         # Forward request tới Native Codex / OpenAI API
│   ├── models/
│   │   ├── model-registry.ts         # Khai báo Web providers (chatgpt-web, m365-copilot) & routes
│   │   └── model-catalog.ts          # Gộp và đồng bộ model catalog cho Codex
│   ├── responses/
│   │   ├── parser.ts                 # Parse request chuẩn Responses API
│   │   ├── state.ts                  # Lưu/khôi phục continuation state (previous_response_id)
│   │   ├── compaction.ts             # Nén ngữ cảnh hội thoại (compact)
│   │   └── schema.ts                 # Schema định nghĩa dữ liệu Responses API
│   └── adapters/
│       ├── base.ts                   # Interface ProviderAdapter
│       ├── web/                      # Shared Web Turn Engine dùng chung cho mọi Web provider
│       │   ├── engine.ts             # WebTurnEngine (orchestrator chính)
│       │   ├── definition.ts         # Contract cấu hình WebProviderDefinition
│       │   ├── runtime-lifecycle.ts  # Mượn/trả browser surface & lease heartbeat
│       │   ├── compile-prompt.ts     # Biên dịch prompt & tool instructions
│       │   ├── protocol/             # Parse, validate & retry giao thức phản hồi Web AI
│       │   ├── execution/            # Turn guard (chống lặp tool vô hạn)
│       │   └── tools/                # Cầu nối tool calls (WebToolBridge)
│       ├── chatgpt-web/              # Adapter cho ChatGPT Web (worker, selectors, store)
│       └── m365-copilot/             # Adapter cho Microsoft 365 Copilot (worker, attachments, picker)
├── launcher/
│   ├── electron/                     # Electron main process, browser host, control-server, supervisor
│   └── src/                          # Giao diện React (Vite) & preload contract
├── scripts/                          # Build bundle, verify, smoke tests, check circular deps
├── tests/                            # Unit & integration tests cho runtime
└── docs/                             # Tài liệu kiến trúc, bảo mật & troubleshooting
```
