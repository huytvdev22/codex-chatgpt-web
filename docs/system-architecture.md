# Kiến trúc hệ thống Codex Web GPT

> **Status:** Current
>
> **Last verified:** 2026-11-05
>
> **Verified against commit:** `7a36e2b`
>
> **Project version:** `6.9.5`
>
> **Source of truth:** Source code, tests, `package.json` và `launcher/package.json`

## 1. Phạm vi tài liệu

Tài liệu này mô tả kiến trúc đang được thể hiện trực tiếp trong mã nguồn:

- Local Responses API server.
- Provider routing và adapter contract.
- Các Web Adapter hiện có.
- Native Codex passthrough.
- Responses continuation và compaction.
- Electron Launcher và browser surface ownership.
- Logging vận hành tối thiểu.
- Build, test và architectural gates.

Tài liệu không mô tả lại chi tiết selector DOM, prompt template hoặc từng model cụ thể. Các nội
dung đó thay đổi thường xuyên và phải được đọc từ source cùng regression tests tương ứng.

## 2. Tổng quan hệ thống

```text
Codex Desktop / Codex CLI
          |
          | HTTP trên loopback
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
          +-- Web provider route
          |      |
          |      +-- ChatGPT Web
          |      +-- Microsoft 365 Copilot
          |      +-- Gemini Web
          |      +-- Google AI Studio
          |      +-- Qwen Web
          |
          +-- Native Codex passthrough
                 |
                 +-- Responses
                 +-- Compact
                 +-- Search
                 +-- Image generation/editing

Electron Launcher
          |
          +-- Runtime supervision
          +-- Embedded browser surfaces
          +-- Browser turn control server
          +-- Codex integration setup
          +-- MCP/tunnel setup where applicable
          +-- Updates, state and local operational logging
```

## 3. Thành phần cấp cao

### 3.1. CLI và service lifecycle

Các entry point chính:

- ../src/cli.ts: xử lý các lệnh CLI như `serve`, `setup` và `doctor`.
- ../src/service.ts: quản lý service lifecycle, drain/resume và active-turn
  cancellation.
- ../src/setup.ts: điều phối cài đặt tích hợp vào Codex.
- ../src/doctor.ts: kiểm tra trạng thái cấu hình và runtime.

Các script chính được khai báo trong ../package.json:

```text
start               Start local server
setup               Install or update Codex integration
doctor              Run diagnostics
test                Run core tests
check:architecture  Check circular dependencies and M365 facade contract
typecheck           Run TypeScript validation
build               Build runtime bundle
verify              Run release-oriented verification
launcher:*          Build, test and run Electron Launcher
```

### 3.2. Local Responses API server

../src/server.ts là ingress chính. Server chạy bằng `Bun.serve` khi Bun có mặt
và có Node HTTP compatibility path cho các môi trường test hoặc runtime khác.

Các route được xác nhận từ source:

| Method | Route | Trách nhiệm |
| --- | --- | --- |
| `GET` | `/v1/models` | Lấy native catalog và bổ sung các Web model khả dụng |
| `POST` | `/v1/responses` | Route request tới Web Adapter hoặc native Codex |
| `POST` | `/v1/responses/compact` | Compact Web context hoặc forward native compact |
| `POST` | `/v1/alpha/search` | Forward native authenticated search |
| `POST` | `/v1/images/generations` | Forward native image generation |
| `POST` | `/v1/images/edits` | Forward native image editing |

`GET /v1/responses` không cung cấp WebSocket transport và trả về HTTP `426`.

Server quản lý vòng đời HTTP turn, client cancellation, drain state và turn interruption. Native
request vẫn được forward thay vì bị ép qua Web Adapter.

### 3.3. Model registry và provider routing

../src/models/model-registry.ts là registry trung tâm cho Web
provider và model route.

Các provider ID hiện được định nghĩa:

```text
chatgpt-web
m365-copilot
gemini-web
google-ai-studio
qwen-web
```

Mỗi provider định nghĩa:

- Exact model slugs.
- Slug prefixes.
- Backend model identity.
- Context window.
- Auto-compaction threshold.
- Composer character limit.
- Input modalities.
- Reasoning levels.

`responseRequest()` trong ../src/server.ts kiểm tra provider theo registry. Nếu
model không thuộc Web provider nhưng là chuỗi hợp lệ, request được forward tới native Codex
Responses API.

## 4. Adapter contract

Contract chung nằm tại ../src/adapters/base.ts:

```ts
interface ProviderAdapter {
  name: string;
  runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
}
```

Ý nghĩa:

- Server chịu trách nhiệm parse request, route provider và tạo HTTP response.
- Adapter chịu trách nhiệm thực hiện một provider turn.
- Adapter phát `AdapterEvent`.
- ../src/bridge.ts chuyển `AdapterEvent` thành Responses API events hoặc kết quả
  JSON không streaming.

Metadata vào adapter chỉ chứa HTTP headers và optional abort signal. Trace context hoặc structured
observability metadata không còn là một phần của contract.

## 5. Web Adapter

### 5.1. ChatGPT Web

Thư mục: ../src/adapters/chatgpt-web/

Các trách nhiệm chính:

- Browser worker và browser helper.
- Model/capability selection.
- Conversation binding.
- Input token và usage accounting.
- MCP entry point cho tool-enabled mode.
- Chuyển ChatGPT DOM response thành adapter events.

### 5.2. Microsoft 365 Copilot

Thư mục: ../src/adapters/m365-copilot/

Các boundary được architectural test xác nhận:

- Root adapter facade.
- Payload normalization.
- Prompt compilation.
- Browser execution.
- Strict response parsing.
- Tool-call translation.
- Native-first tool bridge.
- Loop prevention.

CI kiểm tra:

- Không có circular dependency trong adapter.
- Root facade giữ các public API bắt buộc.
- OS-specific command strategy không bị export qua root facade.

Architectural gate:

```bash
bun run check:architecture
```

### 5.3. Gemini Web

Thư mục: ../src/adapters/gemini-web/

Adapter gồm:

- Capability picker.
- Browser worker.
- Provider facade.
- DOM selectors.

### 5.4. Google AI Studio

Thư mục: ../src/adapters/google-ai-studio/

Adapter gồm:

- Browser worker.
- Capability picker.
- Conversation store.
- Provider facade.
- DOM selectors.

### 5.5. Qwen Web

Thư mục: ../src/adapters/qwen-web/

Adapter gồm:

- Browser worker.
- Conversation store.
- Provider facade.
- DOM selectors.

## 6. Responses lifecycle

### 6.1. Request parsing

../src/responses/parser.ts chuyển wire payload thành
`CodexParsedRequest`.

Adapter không nên tự diễn giải lại toàn bộ raw HTTP body. Provider-specific normalization chỉ xử lý
những phần thuộc contract của provider đó.

### 6.2. Continuation

../src/responses/state.ts cung cấp local continuation cho
`previous_response_id`.

Luồng khái quát:

```text
Incoming request
      |
      +-- no previous_response_id --> parse current input
      |
      +-- previous_response_id
              |
              +-- local state exists --> prepend remembered response items
              |
              +-- state missing --> return explicit continuation error
```

State store chỉ phục vụ replay context cần thiết. State store không lưu structured trace metadata.

### 6.3. Streaming bridge

../src/bridge.ts chuyển adapter events thành Responses API stream.

Các nhóm event chính:

- Text delta.
- Commentary/reasoning-compatible output.
- Tool call start, argument delta và completion.
- Final `response.completed`.
- Error hoặc cancellation.

Bridge không điều khiển DOM và không chọn provider. Bridge chỉ chuyển đổi protocol.

### 6.4. Compaction

../src/responses/compaction.ts chứa định dạng và helper cho compact.

`POST /v1/responses/compact` có hai nhánh:

- Web provider: thêm compaction trigger và chạy qua provider route.
- Native model: forward tới native `responses/compact`.

Chi tiết browser recovery và retained-source behavior được bảo vệ bởi các test compaction trong
../tests/.

## 7. Browser ownership và Launcher

### 7.1. Electron main process

../launcher/electron/main.cjs là composition root của Launcher.

Main process kết nối:

- Persistent launcher state.
- Browser host.
- Provider-specific surface managers.
- Runtime supervisor.
- Control server.
- Installer/update lifecycle.
- IPC với renderer.

### 7.2. Browser host

../launcher/electron/browser-host.cjs quản lý browser
surface và turn tab.

Provider-specific surface managers hiện có:

- ../launcher/electron/chatgpt-surface-manager.cjs
- ../launcher/electron/m365-surface-manager.cjs
- ../launcher/electron/gemini-surface-manager.cjs
- ../launcher/electron/google-ai-studio-surface-manager.cjs
- ../launcher/electron/qwen-surface-manager.cjs

Browser host chịu trách nhiệm ownership và lifecycle. Provider adapter chịu trách nhiệm thao tác
provider page. Không nên chuyển provider parsing vào Electron main process.

### 7.3. Browser control server

../launcher/electron/control-server.cjs cung cấp local
control contract giữa runtime helper và Launcher browser host.

Contract này quản lý:

- Begin turn.
- Heartbeat.
- End turn.
- Helper ownership.
- Retained conversation requirements.
- Explicit cancellation.

Control server không phải public internet API.

### 7.4. Runtime supervisor

../launcher/electron/runtime-supervisor.cjs quản lý
daemon/runtime lifecycle, health checking, recovery và shutdown boundaries.

Daemon hỗ trợ drain/resume để tránh restart hoặc stop khi active turn chưa được giải phóng an toàn.

### 7.5. Renderer

Renderer nằm tại ../launcher/src/:

- ../launcher/src/App.tsx: top-level product flow và settings surfaces.
- ../launcher/src/types.ts: typed preload contract và renderer state.
- ../launcher/src/LimitsSurface.tsx: local usage estimate UI.
- ../launcher/src/i18n.ts: localized UI copy.

Renderer không truy cập trực tiếp filesystem, child process hoặc browser internals. Các hành động
đặc quyền đi qua preload IPC contract.

## 8. Interaction modes

Source và UI hiện phân biệt:

- Automatic browser interaction.
- Manual interaction, được trình bày trong sản phẩm dưới tên Zero Risk.

Trong Automatic mode, browser worker có thể thao tác provider page theo contract của adapter.

Trong manual mode:

- Launcher không tự đọc hoặc gửi nội dung trên page theo workflow Zero Risk.
- Người dùng copy, paste, chọn model/connector và xác nhận `Sent`.
- Control metadata và turn ownership vẫn do local runtime quản lý.

Các thuật ngữ `browser-only`, `full` và MCP capability xuất hiện trong ChatGPT Web product flow.
Provider-specific behavior phải được xác nhận từ adapter, Launcher setup code và tests trước khi
áp dụng cho provider khác.

## 9. Native passthrough

../src/native-passthrough.ts và
../src/native-network.ts giữ native Codex request ngoài Web Adapter path.

Các request được forward gồm:

- Responses.
- Responses compact.
- Search.
- Image generation.
- Image editing.

Authorization của incoming Codex request được dùng theo native forwarding contract. Web browser
session không cung cấp credential cho native OpenAI endpoints.

## 10. Codex integration

Các module ../src/ quản lý route và model catalog được cài vào Codex.

Trách nhiệm được tách thành:

- Shared types và utilities.
- Route document.
- Journal/transaction state.
- Route ownership.
- Catalog synchronization.

Setup phải fail closed khi route hiện tại thuộc một owner khác hoặc khi transaction không thể chứng
minh hoàn tất.

## 11. Logging và diagnostics

Structured observability, trace propagation và Activity/Trace Explorer đã bị loại bỏ.

../launcher/electron/logging.cjs vẫn được giữ làm operational
logger tối thiểu cho:

- Launcher startup.
- Process và stream failures.
- IPC handler failures.
- Runtime supervision.
- Log rotation.
- Credential redaction.

Logger này không phải distributed tracing system và không cung cấp Activity UI hoặc safe-log export.
Local JSONL log phải được xem là dữ liệu nhạy cảm.

## 12. Security boundaries

Các boundary chính:

1. Loopback HTTP server là local ingress nhưng vẫn phải xác thực các admin/control action.
2. Browser profile chứa authenticated session và là dữ liệu nhạy cảm.
3. Renderer không được gọi trực tiếp privileged Node/Electron APIs.
4. Provider DOM không được coi là trusted structured input.
5. Tool call phải được parse, normalize và validate trước khi forward.
6. Native request authorization không được lấy từ browser session.
7. Cancellation, ownership mismatch và ambiguous lifecycle phải fail closed.
8. Log không được trở thành kênh lưu prompt, response hoặc credential.

Chi tiết security invariant nằm tại [`security-model.md`](security-model.md).

## 13. Dependency rules

### Bắt buộc

- `server` phụ thuộc adapter contract, model registry, response modules và native passthrough.
- Adapter phụ thuộc provider-specific browser, normalization, prompt và translation modules.
- `bridge` phụ thuộc adapter events, không phụ thuộc DOM selectors.
- Launcher renderer phụ thuộc preload contract, không phụ thuộc Electron internals.
- Electron main process sở hữu privileged operations và browser surfaces.

### Không được làm

- Không import provider DOM logic vào `src/server.ts`.
- Không để adapter sửa Codex installation trực tiếp.
- Không để renderer truy cập filesystem hoặc process APIs ngoài preload.
- Không export OS-specific implementation qua facade nếu facade contract không yêu cầu.
- Không thêm trace/telemetry metadata vào business interfaces nếu không có requirement và tests.
- Không silently fallback sang provider, model hoặc reasoning level khác.

## 14. Validation

### Core

```bash
bun run test
bun run typecheck
bun run check:architecture
bun run build
bun run smoke
```

### Launcher

```bash
bun run launcher:typecheck
bun run launcher:build
bun run launcher:test
bun run app:package
bun run app:smoke
```

### Release

```bash
bun run verify
```

CI và build smoke không thay thế account-bound validation. Quy trình phát hành thủ công nằm tại
[`release-validation.md`](release-validation.md).

## 15. Quy tắc cập nhật tài liệu

Phải cập nhật tài liệu này khi thay đổi một trong các thành phần:

- HTTP route hoặc routing precedence.
- `ProviderAdapter` contract.
- Provider ID hoặc model registry schema.
- `AdapterEvent` hoặc Responses bridge contract.
- Continuation/compaction behavior.
- Browser ownership hoặc control-server contract.
- Interaction mode.
- Codex integration transaction.
- Security boundary.

Nếu source và tài liệu khác nhau, source cùng tests là nguồn sự thật.

Không thêm thông tin roadmap, phỏng đoán provider behavior hoặc số liệu chưa được source/tests chứng
minh vào tài liệu này. Nội dung chưa xác minh phải được ghi thành câu hỏi mở hoặc issue riêng.
