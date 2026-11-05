# Codex M365 Copilot

> **Phiên bản hiện tại:** `6.9.5`
>
> **Runtime:** Bun `1.4.0`
>
> **Desktop Launcher:** Electron `42`, React `19`, Vite `6`
>
> **Nền tảng đóng gói:** Windows x64, macOS 13+ và Linux x64

Codex M365 Copilot là một bridge cục bộ giúp Codex Desktop hoặc Codex CLI sử dụng các mô hình AI
thông qua giao diện Web. Dự án cung cấp một Responses API trên loopback, định tuyến request tới
Web Adapter phù hợp hoặc chuyển tiếp request tới native Codex khi model không thuộc Web provider.

## Nội dung

- #tính-năng-chính
- #kiến-trúc
- #provider-được-hỗ-trợ
- #cài-đặt
- #thiết-lập
- #sử-dụng
- #chạy-từ-mã-nguồn
- #kiểm-thử-và-build
- #bảo-mật-và-giới-hạn
- #tài-liệu

## Tính năng chính

- Tích hợp Web model vào model catalog của Codex.
- Giữ native Codex models và native request passthrough.
- Hỗ trợ Responses API dạng streaming và non-streaming.
- Hỗ trợ `previous_response_id` bằng continuation state cục bộ.
- Hỗ trợ compact context cho Web provider và native model.
- Chuyển tiếp native Search, Image Generation và Image Editing.
- Quản lý browser surface bằng Electron Launcher.
- Hỗ trợ text và image input theo capability của từng model.
- Quản lý turn ownership, heartbeat, cancellation và retained conversation.
- Fail closed khi model, browser state, tool call hoặc lifecycle không thể được xác minh.

## Kiến trúc

```text
Codex Desktop / Codex CLI
          |
          | Responses API trên loopback
          v
Local Responses API Server
          |
          +-- GET  /v1/models
          +-- POST /v1/responses
          +-- POST /v1/responses/compact
          +-- POST /v1/alpha/search
          +-- POST /v1/images/generations
          +-- POST /v1/images/edits
          |
          +-- Web provider
          |      +-- ChatGPT Web
          |      +-- Microsoft 365 Copilot
          |      +-- Gemini Web
          |      +-- Google AI Studio
          |      +-- Qwen Web
          |
          +-- Native Codex passthrough

Electron Launcher
          |
          +-- Embedded browser surfaces
          +-- Provider surface managers
          +-- Runtime supervisor
          +-- Browser control server
          +-- Codex integration
          +-- Update và operational logging
```

Các boundary chính:

- `src/server.ts` chịu trách nhiệm HTTP ingress và provider routing.
- `src/models/model-registry.ts` là registry cho Web provider và model route.
- `src/adapters/base.ts` định nghĩa `ProviderAdapter`.
- `src/bridge.ts` chuyển `AdapterEvent` thành Responses API output.
- `src/responses/` quản lý parsing, continuation và compaction.
- `launcher/electron/` sở hữu Electron process, browser surfaces và runtime lifecycle.
- `launcher/src/` chứa renderer React và typed preload contract.

Xem chi tiết tại:

- docs/system-architecture.md
- docs/architecture.md
- docs/security-model.md

## Provider được hỗ trợ

Provider và model route được khai báo tập trung trong `src/models/model-registry.ts`.

| Provider ID | Mô tả |
| --- | --- |
| `chatgpt-web` | ChatGPT Web với chế độ thường hoặc suy nghĩ |
| `m365-copilot` | Microsoft 365 Copilot Web |
| `gemini-web` | Google Gemini Web |
| `google-ai-studio` | Google AI Studio |
| `qwen-web` | Qwen Web |

Model catalog, context window, compaction threshold, composer limit, input modality và reasoning
level được lấy từ registry. Không nên ghi cứng model route ở module khác.

## Cài đặt

Tải bản phù hợp từ trang
[GitHub Releases](https://github.com/miuuyy/codex-chatgpt-web/releases/latest).

Các định dạng package hiện được cấu hình:

| Nền tảng | Kiến trúc | Định dạng |
| --- | --- | --- |
| Windows | x64 | NSIS `.exe` |
| macOS | arm64, x64 | `.dmg`, `.zip` |
| Linux | x64 | `.AppImage` |

### macOS và Linux

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

### Windows PowerShell

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

Launcher package chứa Electron và runtime cần thiết. Người dùng bản đóng gói không cần cài riêng
Node.js, Bun hoặc Chromium.

## Thiết lập

1. Mở Launcher.
2. Đăng nhập provider cần sử dụng trong browser surface tương ứng.
3. Chạy bước kiểm tra provider nếu Launcher cung cấp.
4. Chọn **Install models** hoặc **Reinstall** để Launcher cài route và model catalog vào Codex.
5. Thoát hoàn toàn rồi mở lại Codex để nạp model catalog mới.
6. Chọn Web model phù hợp trong model picker của Codex.

Việc đăng nhập browser provider và đăng nhập Codex là hai session riêng. Dữ liệu đăng nhập của
browser được giữ trong Electron profile do Launcher sở hữu.

### Cách Codex gửi request tới Local Responses API Server

Codex không tự phát hiện Local Responses API Server. Bước **Install models** gọi setup flow của dự
án, sau đó `installCodexIntegration()` cập nhật route trong file `~/.codex/config.toml`.

Với cấu hình mặc định, route được cài có dạng:

```toml
# Route do codex-chatgpt-web quản lý
openai_base_url = "http://127.0.0.1:17841/v1"
model_provider = "openai"
model_catalog_json = "/đường/dẫn/tới/model-catalog-do-launcher-quản-lý.json"
```

Ý nghĩa của từng trường:

- `openai_base_url` đổi đích gửi request của built-in OpenAI provider từ endpoint mặc định sang
  Local Responses API Server trên `127.0.0.1`.
- `model_provider = "openai"` giữ Codex sử dụng built-in provider và wire protocol chuẩn của Codex.
  Dự án không đăng ký một custom model provider mới.
- `model_catalog_json` trỏ Codex tới catalog đã được bổ sung Web models từ model registry của dự án.

Do đó, từ góc nhìn Codex, request vẫn sử dụng Responses API contract của built-in OpenAI provider,
nhưng HTTP request được gửi tới:

```text
http://127.0.0.1:17841/v1
```

thay vì gửi trực tiếp tới endpoint OpenAI mặc định.

```text
Codex
  |
  | đọc ~/.codex/config.toml
  | openai_base_url = http://127.0.0.1:17841/v1
  v
Local Responses API Server
  |
  +-- Web model ID --> Web Adapter tương ứng
  |
  +-- Native model ID --> forward tới native Codex/OpenAI endpoint
```

Local server mặc định bind tại:

```text
Host: 127.0.0.1
Port: 17841
Base URL: http://127.0.0.1:17841/v1
```

Port có thể thay đổi trong runtime config. Setup dùng đúng `host` và `port` hiện hành để tạo
`openai_base_url`.

### Trình tự setup thực tế

Setup thực hiện theo thứ tự:

1. Đọc cấu hình runtime hiện có.
2. Kiểm tra port local có thể sử dụng.
3. Kiểm tra browser host và capability của tài khoản khi workflow yêu cầu.
4. Lưu runtime config.
5. Khởi động hoặc kết nối runtime do Launcher sở hữu.
6. Kiểm tra health endpoint của Local Responses API Server.
7. Gọi `installCodexIntegration()` để cập nhật Codex route.
8. Ghi managed model catalog.
9. Yêu cầu khởi động lại Codex.

Codex phải được khởi động lại vì process đang chạy giữ model catalog và route đã đọc trước đó.

### Xử lý route đã tồn tại

Setup hoạt động theo nguyên tắc fail closed:

- Nếu `openai_base_url` đã được một công cụ khác cấu hình, setup không tự ghi đè.
- Nếu `model_provider` đang chọn custom provider, setup từ chối thay đổi.
- Chỉ built-in `model_provider = "openai"` hoặc trạng thái chưa khai báo provider được chấp nhận.
- Muốn thay thế một route URL đã tồn tại phải dùng thao tác thay thế route rõ ràng từ Launcher hoặc
  tùy chọn `--replace-codex-route`.
- Giá trị trước khi cài được ghi vào integration journal để có thể khôi phục khi disconnect hoặc
  uninstall.
- Nếu route bị người dùng hoặc công cụ khác sửa sau setup, dự án từ chối ghi đè giá trị mới đó.

### Kiểm tra route sau setup

Sau khi cài đặt, chạy:

```bash
bun run doctor
```

Hoặc khi chạy bản đóng gói, dùng **Settings → Run doctor** trong Launcher.

Có thể kiểm tra thủ công `~/.codex/config.toml` và xác nhận:

```toml
openai_base_url = "http://127.0.0.1:17841/v1"
```

Sau đó kiểm tra local server:

```bash
curl http://127.0.0.1:17841/healthz
curl http://127.0.0.1:17841/v1/models
```

Health response hợp lệ phải xác nhận service `codex-chatgpt-web` đang ở trạng thái `ok` và đang
nhận turn mới. `/v1/models` phải trả catalog mà Codex sẽ sử dụng.

## Sử dụng

### Chế độ tự động

Runtime và browser worker thực hiện provider turn theo adapter contract:

1. Codex gửi request tới local Responses API.
2. Server nhận diện provider từ model ID.
3. Request được parse và mở rộng continuation nếu có.
4. Adapter biên dịch prompt và thực hiện browser turn.
5. Provider response được parse thành text hoặc tool call.
6. Bridge phát Responses API events về Codex.

### Chế độ thủ công

Launcher có workflow tương tác thủ công, được trình bày trong sản phẩm dưới tên Zero Risk:

- Launcher chuẩn bị nội dung cần gửi.
- Người dùng tự copy, paste, chọn model và gửi trên giao diện provider.
- Người dùng xác nhận trạng thái `Sent`.
- Runtime vẫn quản lý request identity, ownership và cancellation.

Không áp dụng hành vi của một provider cho provider khác nếu chưa có source và regression test
xác nhận.

## API cục bộ

| Method | Endpoint | Mục đích |
| --- | --- | --- |
| `GET` | `/v1/models` | Native catalog và Web model catalog |
| `POST` | `/v1/responses` | Responses request |
| `POST` | `/v1/responses/compact` | Context compaction |
| `POST` | `/v1/alpha/search` | Native authenticated search |
| `POST` | `/v1/images/generations` | Native image generation |
| `POST` | `/v1/images/edits` | Native image editing |

`GET /v1/responses` không hỗ trợ WebSocket transport và trả về HTTP `426`.

## Chạy từ mã nguồn

### Yêu cầu

- Bun `1.4.0`
- Git
- Desktop session nếu chạy Electron Launcher

### Khởi động Launcher

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git
cd codex-chatgpt-web
bun install --frozen-lockfile
bun run app
```

### Khởi động server

```bash
bun run start
```

### Các lệnh CLI chính

```bash
bun run src/cli.ts setup
bun run src/cli.ts doctor
bun run src/cli.ts serve
bun run src/cli.ts subagents status
bun run src/cli.ts subagents compatibility-v1
bun run src/cli.ts subagents native
bun run src/cli.ts uninstall --yes
```

Lệnh CLI cũng hỗ trợ các nhóm lệnh `login`, `route`, `browser`, `service`, `hook` và `open`.
Chạy help để xem contract hiện tại:

```bash
bun run src/cli.ts help
```

## Kiểm thử và build

### Core runtime

```bash
bun run test
bun run typecheck
bun run check:architecture
bun run build
bun run smoke
```

### Electron Launcher

```bash
bun run launcher:typecheck
bun run launcher:build
bun run launcher:test
bun run app:package
bun run app:smoke
```

### Quality gate tổng hợp

```bash
bun run verify
```

`check:architecture` kiểm tra circular dependency và public facade contract của Microsoft 365
Copilot Adapter.

CI, build và package smoke không thay thế kiểm thử có tài khoản thật. Xem
docs/release-validation.md trước khi phát hành.

## Logging và chẩn đoán

Runtime không còn hệ thống structured observability, trace propagation hoặc Activity/Trace
Explorer. Launcher chỉ giữ operational logging tối thiểu.

Launcher vẫn giữ operational logging tối thiểu để ghi:

- Lỗi startup.
- Lỗi process hoặc stream.
- Lỗi IPC handler.
- Runtime supervision failure.
- Thông tin cần thiết cho log rotation.

Local launcher JSONL log là dữ liệu nhạy cảm. Không chia sẻ log chưa được kiểm tra và làm sạch.

Khi gặp lỗi:

1. Chạy `doctor`.
2. Ghi lại lỗi đầy đủ, thời điểm xảy ra, hệ điều hành, Launcher version, provider, model và
   interaction mode.
3. Thử lại đúng một lần trong Codex task mới.
4. Đọc [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Bảo mật và giới hạn

- Đây là browser automation không chính thức, không phải API của các Web provider.
- Provider có thể thay đổi DOM và làm selector không còn hợp lệ.
- Browser profile chứa authenticated session và phải được xem là dữ liệu bí mật.
- Loopback listener có thể được truy cập bởi process chạy cùng máy người dùng.
- Provider DOM không được coi là structured input đáng tin cậy.
- Tool call phải được parse, normalize và validate trước khi forward.
- Không tự động fallback sang provider, model hoặc reasoning level khác.
- Native OpenAI authorization không được lấy từ browser session.
- Lifecycle không rõ ràng, ownership mismatch hoặc cancellation phải fail closed.
- Build hiện chưa được platform-sign nên Gatekeeper hoặc SmartScreen có thể cảnh báo.

Đọc [SECURITY.md](SECURITY.md) trước khi báo cáo lỗ hổng hoặc gửi dữ liệu chẩn đoán.

## Cấu trúc repository

```text
src/
  adapters/             Provider adapters
  models/               Model registry và catalog
  responses/            Parsing, state và compaction
  usage/                Usage accounting
  server.ts             Local Responses API server
  bridge.ts             AdapterEvent sang Responses API
  cli.ts                CLI entry point

launcher/
  electron/             Electron main process và browser ownership
  src/                  React renderer
  tests/                Launcher tests

tests/                  Core và adapter regression tests
scripts/                Build, verification, installer và release scripts
docs/                   Architecture, security và release documentation
```

## Tài liệu

- docs/README.md
- docs/system-architecture.md
- docs/architecture.md
- docs/security-model.md
- docs/release-validation.md
- docs/adding-new-web-adapter-guide.md
- docs/build-windows.md
- [Troubleshooting](TROUBLESHOOTING.md)
- [Contributing](CONTRIBUTING.md)

## Trạng thái dự án

Source code, tests và scripts là nguồn sự thật. Nếu README hoặc tài liệu kiến trúc khác với
implementation, ưu tiên theo thứ tự:

1. Source code đang chạy.
2. Tests và architectural gates.
3. Build, release và configuration scripts.
4. Tài liệu được đánh dấu `Current`.
5. Historical incident và Git history.

## Giấy phép

Dự án được phát hành theo LICENSE.

Dự án là phần mềm độc lập, không liên kết hoặc được xác nhận bởi OpenAI, Microsoft, Google, Alibaba
Cloud hay các Web provider được tích hợp. Chỉ sử dụng với tài khoản của chính người dùng và tuân thủ
điều khoản dịch vụ, chính sách workspace cùng quy định áp dụng.
