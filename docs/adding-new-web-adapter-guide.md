# Hướng Dẫn Thiết Kế & Tích Hợp Web Adapter Mới

Tài liệu này định nghĩa tư duy thiết kế, hợp đồng lập trình và các điểm chạm tích hợp khi thêm một Web Provider mới vào `codex-chatgpt-web`.

---

## 1. Tư duy Thiết kế Cốt lõi

Toàn bộ các Web Provider dùng chung một đường ống điều phối duy nhất. Khi thêm provider mới, bạn **không xây lại luồng chạy**, mà chỉ **cắm (plug-in)** phần danh mục model, thao tác DOM trình duyệt và cấu hình Launcher của provider vào khung có sẵn:

```text
ModelRegistry (src/models/) + AdapterRegistry (src/adapters/adapter-registry.ts)
    ↓ phân giải model -> khởi tạo adapter theo cùng providerId
ProviderAdapter (src/adapters/base.ts)
    ↓
WebProviderAdapter (src/adapters/web/web-provider-adapter.ts)
    ↓
WebTurnEngine (src/adapters/web/engine.ts)
    ↓
WebProviderDefinition (src/adapters/web/definition.ts)
    ↓
Provider Drivers & Policies (conversation, capability, attachments, browser, response, policies)
```

### Quy trình tích hợp ở mức khái niệm
```text
Khảo sát DOM website
  → Viết Model Provider (kế thừa BaseModelProvider)
  → Viết Browser Worker (kế thừa BaseWebBrowserWorker) & Capability Picker
  → Khai báo WebProviderDefinition + Facade kế thừa WebProviderAdapter
  → Đăng ký vào ModelRegistry, AdapterRegistry & Launcher BrowserProviderRegistry
  → Kiểm chứng qua Architecture Gates, Unit Tests & Launcher Build
```

### Các bước tích hợp thực tế

1. **Khảo sát giao diện provider**
   - User đăng nhập và mở trực tiếp giao diện web cần tích hợp bằng browser profile dành cho provider.
   - Dùng DevTools để xác định URL hội thoại, composer, nút gửi, nút dừng, vùng câu trả lời, trạng thái đang sinh nội dung, model/reasoning picker và khu vực upload nếu có.
   - Ghi nhận selector ở nhiều trạng thái: trang mới, đang trả lời, trả lời xong, hội thoại cũ, lỗi đăng nhập và giới hạn sử dụng.
   - Ưu tiên thuộc tính ổn định như `data-testid`, `aria-label`, `role` hoặc cấu trúc semantic; tránh class CSS sinh động và selector phụ thuộc vị trí.
   - Không lưu cookie, access token, nội dung hội thoại hoặc thông tin đăng nhập vào mã nguồn và tài liệu.

2. **Tạo provider adapter (`src/adapters/<provider>/`)**
   - Tạo `model-provider.ts` kế thừa `BaseModelProvider` (`src/models/base-model-provider.ts`) khai báo `id`, `exactSlugs`, `slugPrefixes`, `routes` và `static getInstance()`.
   - Tạo `*-browser-worker.ts` kế thừa `BaseWebBrowserWorker` (`src/adapters/web/browser/base-browser-worker.ts`). `BaseWebBrowserWorker` sở hữu Template Method `executeTurn()` và vòng lặp `waitForCompletion()` (heartbeat, abort, timeout); provider chỉ implement các bước DOM (`navigate`, `captureResponseBaseline`, `insertPrompt`, `submitPrompt`, `observeResponse`, `extractCompletedResponse`, `resolveConversationId`, `stopGeneration`).
   - Chỉ thêm `selectors.ts`, DOM observer, clipboard salvage, capability picker hoặc attachment handler khi giao diện provider cần các chức năng tương ứng.
   - Tạo facade `index.ts` kế thừa `WebProviderAdapter` (`src/adapters/web/web-provider-adapter.ts`) và export factory `create<Provider>Adapter()`.

3. **Khai báo contract dùng chung**
   - Khai báo `WebProviderDefinition` gồm `conversation`, `browser` và các driver tùy chọn (`capability`, `attachments`, `response`).
   - Chọn policy theo hành vi thực tế của provider; ưu tiên mặc định của `WebTurnEngine`.
   - Bảo đảm raw stream không được emit ra ngoài trước khi shared protocol hoàn tất validation.

4. **Đăng ký vào hệ thống**
   - Đăng ký `ModelProvider` vào `ModelRegistry.defaultInstance` trong `src/models/model-registry.ts`.
   - Đăng ký adapter factory vào `AdapterRegistry.defaultInstance` trong `src/adapters/adapter-registry.ts` với **cùng `providerId` với `BaseModelProvider.id`**.
   - Tạo Launcher browser provider tại `launcher/electron/browser/providers/<provider>/` kế thừa `BaseBrowserProvider` (`launcher/electron/browser/providers/base-browser-provider.cjs`), dùng partition hợp lệ (ví dụ `persist:codex-web-<provider>`), rồi đăng ký vào `createDefaultProviderRegistry()` trong `launcher/electron/browser/browser-host.cjs`.
   - Giao diện Launcher (`SetupSurface` và `.provider-switcher` trong `BrowserSurface`) đọc động danh sách từ `BrowserProviderRegistry`; chỉ cập nhật UI/i18n khi provider có luồng đặc thù.

5. **Kiểm chứng trên giao diện thật**
   - Kiểm tra gửi prompt lần đầu, tiếp tục hội thoại, format retry, structured output (`json_schema` / `retain: false`), abort và khôi phục sau lỗi.
   - Nếu có model/reasoning picker hoặc attachment, kiểm tra riêng từng trạng thái và xác nhận selector không phụ thuộc ngôn ngữ giao diện khi có thể.
   - Sau mỗi lần website thay đổi giao diện, khảo sát lại DOM và cập nhật selector trước khi thay đổi shared Web layer.

6. **Bổ sung test và chạy quality gates**
   - Thêm contract test cho facade, model provider, conversation lifecycle, retry, Launcher `BrowserProvider` và các đặc thù của provider.
   - Chạy đầy đủ cả pipeline root lẫn Electron Launcher (`check:architecture`, `typecheck`, `test`, `build`) theo checklist ở Mục 7.

---

## 2. Phân tách Trách nhiệm (Shared vs. Provider)

| Tầng | Sở hữu | Tuyệt đối KHÔNG chứa |
| :--- | :--- | :--- |
| **Core & Shared Web Layer** (`src/models/`, `src/services/`, `src/adapters/web/`) | - `ModelRegistry`, `ModelCatalog`, `AdapterRegistry` & `ResponsesService` định tuyến động theo provider<br>- Điều phối vòng đời lượt chạy (`WebTurnEngine`, `runtime-lifecycle.ts`)<br>- Chuẩn hóa payload 1 lần & biên dịch prompt trung tính (`normalization/`, `prompt/`, `compile-prompt.ts`)<br>- Khung thực thi browser worker (`BaseWebBrowserWorker`)<br>- Giao thức `<webResponse>`, JSON Schema structured output, parser, validator, format-retry, `WebOutputTranslator`, `WebToolCallDetector`, event emission (`protocol/`)<br>- Chuẩn hóa & ánh xạ công cụ (`tools/`, `WebToolBridge`)<br>- Chống lặp vô hạn & dẫn xuất khóa hội thoại (`execution/WebTurnLoopGuard`, `conversation/`) | - Selector DOM hoặc URL của bất kỳ provider nào<br>- Logic nhánh `if (provider === ...)`<br>- Import ngược từ `src/adapters/<provider>/` trong `src/adapters/web/` |
| **Provider Layer** (`src/adapters/<provider>/`) | - `model-provider.ts`: Kế thừa `BaseModelProvider`, khai báo slug & reasoning routes<br>- `index.ts`: Khai báo `WebProviderDefinition` (gồm `policies.maxPromptChars`, `attachments.maxInputImages`) & kế thừa `WebProviderAdapter`<br>- `*-browser-worker.ts`: Kế thừa `BaseWebBrowserWorker`, chỉ implement thao tác UI trang đích & đọc `rawResponse`<br>- `capability-picker.ts`, `selectors.ts`, `conversation-url.ts` / `conversation-key.ts` | - Tự viết lại `runTurn()`, prompt compiler, payload normalization hay vòng lặp chờ stream/heartbeat<br>- Tự quản lý Launcher lifecycle, trừ ngoại lệ được phê duyệt với `manageLauncherLeaseInEngine: false` (M365 là trường hợp tham chiếu)<br>- Tự gọi parser, validator, retry hay emit event giao thức |

---

## 3. Năm Hợp đồng Driver trong `WebProviderDefinition`

Một provider được mô tả trọn vẹn qua 5 nhóm driver trong `src/adapters/web/definition.ts`:

1. **`conversation` (`WebConversationDriver`)**:
   - Xác định khóa hội thoại ổn định bằng `buildWebConversationKey` (`src/adapters/web/conversation/conversation-key.ts`) hoặc hàm conversation-key đặc thù của provider.
   - Quyết định khi nào tái sử dụng hội thoại cũ (`resolveState`).
   - Quyết định việc gắn kết surface (`connectorBound`, `conversationId`) và **có giữ lại tab/hội thoại hay không (`retain?: boolean`)** trong `resolveEndTurnBinding`. Các lượt phụ không lưu lịch sử (như `json_schema` / sinh tiêu đề) nên trả về `retain: false`.
2. **`capability` (`WebCapabilityPickerDriver` - tùy chọn)**:
   - Ánh xạ `CodexParsedRequest` sang mức suy luận (`resolveReasoningEffort`). Nếu provider cần kết hợp cả model slug lẫn mức suy luận trên giao diện, sử dụng thêm `parsed.modelId` + `parsed.options.reasoning` trong `browser.executeTurn` kết hợp `resolveReasoningMode()` trên `BaseModelProvider`.
3. **`attachments` (`WebAttachmentDriver` - tùy chọn)**:
   - Khai báo `maxInputImages` và trích xuất hình ảnh đính kèm ở lần gửi đầu tiên (`attempt === 0`). Không gửi lại ảnh ở các vòng retry định dạng.
4. **`browser` (`WebBrowserDriver`)**:
   - Nhận `Page` và các cờ trạng thái (`isNewConversation`, `retain`, `attempt`, `reasoningEffort`, `heartbeat`) từ Engine, thực thi thao tác DOM và chỉ trả về `{ rawResponse, conversationId }`.
   - Bắt buộc khai báo `launcherProviderId` và `connectorIdentity` khớp với `BaseBrowserProvider` bên Launcher.
   - Có thể khai báo `descriptorPath`, `descriptorSubdirs` và `resolveSurfaceId` (thường ưu tiên `leaseSurfaceId || descriptor.providerSurfaceIds?.[launcherProviderId] || descriptor.surfaceId`).
5. **`response` (`WebResponseDriver` - tùy chọn)**:
   - Tinh chỉnh hậu xử lý nếu trang web có đặc thù riêng: lọc rác UI bao quanh (`sanitizeRawResponse`), cho phép văn bản tự nhiên khi không có công cụ (`tolerantNaturalTextFallback`), hoặc tính toán token (`computeUsage`).
   - Có thể tùy chỉnh phân loại lỗi validation, call ID và chi tiết sự kiện kết thúc, nhưng không tự gọi parser, validator hay event emitter.

---

## 4. Các Nguyên lý Xử lý Trình duyệt & Phản hồi

1. **Cách ly Luồng Thô (Raw Stream Quarantine)**:
   - Trong lúc trình duyệt đang stream câu trả lời, worker chỉ thu thập dữ liệu nội bộ (có thể dùng `FastPathStreamBuffer`, `SemanticMarkdownBuffer`, `webHtmlToMarkdown` hoặc preset HTML→Markdown riêng truyền qua `new SemanticMarkdownBuffer({ htmlToMarkdown })`), **không** phát trực tiếp chunk thô ra Codex trước khi `WebTurnEngine` hoàn tất kiểm duyệt `<webResponse>`.
2. **Trích xuất Đa tầng (chiến lược khuyến nghị, không phải contract bắt buộc)**:
   - **Ưu tiên 1:** Bắt nội dung nguyên bản từ nút Copy của khối code Markdown ngoài cùng (qua clipboard hook nội bộ trong trang, không chạm OS clipboard của người dùng).
   - **Ưu tiên 2:** Nếu không có nút Copy, trích xuất từ vùng DOM câu trả lời và loại bỏ các thành phần trang trí UI.
   - Provider có thể dùng chiến lược khác nếu website không có nút Copy hoặc DOM streaming không ổn định, miễn `executeTurn` trả về `rawResponse` đầy đủ và không phát nội dung chưa kiểm duyệt.
3. **Tự sửa lỗi trên cùng Hội thoại (In-Place Format Retry)**:
   - Khi phản hồi vi phạm giao thức `<webResponse>` hoặc JSON Schema, `WebTurnEngine` tự động gửi prompt nhắc sửa lỗi ngay trên `conversationId` vừa tạo (`attempt > 0` luôn có `isNewConversation = false`).
4. **Structured Output (`json_schema`) & Tab tạm (`retain: false`)**:
   - `WebTurnEngine` tự nhận diện lượt `json_schema` (không có pending tool result), biên dịch prompt chuyên biệt và kiểm định bằng `parseAndValidateJsonSchemaResponse`. Worker cần tôn trọng cờ `options.retain === false` để bỏ qua việc chờ URL hội thoại persistent và cho phép Launcher đóng tab ngay khi hoàn tất lượt.

---

## 5. Quyết định Chính sách Vòng đời (`WebProviderPolicies`)

Mỗi provider chọn tổ hợp chính sách phù hợp trong `src/adapters/web/definition.ts` thay vì viết câu lệnh điều kiện:

- **`browserTransport`**:
  - `"playwright-cdp"` (mặc định): Điều khiển surface bằng Playwright `Page` qua CDP.
  - `"electron-control"`: Bỏ qua `connectBrowserHost()` CDP; điều khiển `WebContentsView` trực tiếp qua endpoint nội bộ `POST /v1/surface/action` (`ElectronSurfaceClient` + `SurfaceActionExecutor`) bằng `executeJavaScript(..., true)` và `sendInputEvent` nhằm tránh dấu vết CDP đối với các trang có anti-bot/BotGuard như Google AI Studio.
- **`launcherFailureMode`**:
  - `"fail-closed"` (mặc định): Bắt buộc chạy trên trình duyệt của Launcher; báo lỗi ngay nếu mất kết nối CDP.
  - `"fallback-local"`: Cho phép rơi về `LocalBrowserRuntime` khi Launcher không chạy.
- **`manageLauncherLeaseInEngine`**:
  - `true` (mặc định): Engine quản lý lease `start`/`end` bao trọn cả lượt chạy.
  - `false`: Ngoại lệ có chủ đích, chỉ dùng khi worker bắt buộc tự quản lý lease theo từng attempt.
- **`closeLauncherConnectionOnEnd`**:
  - `true` (mặc định): Đóng kết nối Playwright CDP trong khối `finally`.
  - `false`: Giữ kết nối mở sau khi báo `phase=end` nếu provider tái sử dụng trực tiếp session trình duyệt.
- **`emitErrorEventOnFailure` & `rethrowError`**:
  - Quyết định việc phát sự kiện `{ type: "error" }` tại Engine hay để tầng Server xử lý ngoại lệ, tránh nhân đôi lỗi trên stream.
- **`errorMessagePrefix` & `abortedTurnMessage`**:
  - Tùy chỉnh tiền tố lỗi phát ra stream và thông báo `AbortError`; chỉ đặt khi provider cần thông điệp đặc thù.
- **`maxFormatRetries` & `maxPromptChars`**:
  - Số lần gửi lại prompt sửa định dạng (mặc định `2`, hỗ trợ hàm đọc cấu hình runtime) và ngưỡng cắt tỉa prompt (mặc định `95_000`).
- **`enableEarlyExitOnFinalAnswer` & `enableToolLoopGuard`**:
  - Ngắt sớm nếu hội thoại đã kết thúc bằng câu trả lời của assistant và bảo vệ chống lặp vô hạn công cụ (`conversationGuard`).
- **`traceIdOptions`**:
  - Tùy chỉnh số byte và encoding (`base64url` hoặc `hex`) của trace ID khi provider hoặc Launcher có contract riêng.

### Nguyên tắc chọn policy

- Bắt đầu từ mặc định của `WebTurnEngine`; chỉ khai báo policy khi hành vi provider thực sự khác mặc định.
- Không dùng policy để che giấu lỗi worker hoặc bỏ qua validation.
- Mọi ngoại lệ lifecycle cần có contract test và ghi rõ lý do trong `docs/troubleshooting/`.

---

## 6. Điểm chạm Tích hợp Hệ thống

Ngoài thư mục `src/adapters/<provider>/`, một provider mới chạm vào **4 nhóm điểm tích hợp chuẩn**:

1. **Model Provider & Registry (`src/adapters/<provider>/model-provider.ts` & `src/models/model-registry.ts`)**:
   - Tạo class kế thừa `BaseModelProvider` (`src/models/base-model-provider.ts`) khai báo `id`, `exactSlugs`, `slugPrefixes`, `routes` và `getInstance()`.
   - Đăng ký `.getInstance()` vào `ModelRegistry.defaultInstance` trong `src/models/model-registry.ts`.
   - `ModelCatalog` (`src/models/model-catalog.ts`) và `codex-integration.ts` tự động tổng hợp từ `ModelRegistry`; `ModelProviderId` trong `src/models/types.ts` đã là `string`.
2. **Adapter Registry (`src/adapters/adapter-registry.ts`) & Responses Service (`src/services/responses-service.ts`)**:
   - Đăng ký factory `() => ProviderAdapter` vào `AdapterRegistry.defaultInstance` trong `src/adapters/adapter-registry.ts` với **key trùng khớp `BaseModelProvider.id`**.
   - `ResponsesService` tự động giải quyết `model` → `ModelRegistry.findProvider()` → `AdapterRegistry.createAdapter(provider.id)` (`src/server.ts` ủy quyền hoàn toàn qua `ResponsesController` và không giữ bảng định tuyến riêng).
3. **Launcher Browser Provider (`launcher/electron/browser/providers/<provider>/` & `launcher/electron/browser/browser-host.cjs` & `src/launcher-browser-host.ts`)**:
   - Tạo class kế thừa `BaseBrowserProvider` (`launcher/electron/browser/providers/base-browser-provider.cjs`), implement 6 abstract method bắt buộc (`normalizeConversationId`, `conversationUrl`, `parseConversationId`, `isAllowedNavigation`, `probeAuthentication`, `markTurnSurface`) và override `runSmokeTest` nếu hỗ trợ verify trên Launcher.
   - Đăng ký instance provider mới trong `createDefaultProviderRegistry()` tại `launcher/electron/browser/browser-host.cjs`.
   - Đặt `partition` khớp regex bảo mật trong `src/launcher-browser-host.ts`: production phải khớp `/^persist:codex-(?:web-gpt-|web-|m365-)[a-z0-9-]+$/` (khuyến nghị `persist:codex-web-<provider>`, tránh `persist:codex-<provider>` vì sẽ bị từ chối); development phải khớp `/^persist:codex-web-gpt-dev-[a-z0-9-]+$/`.
   - Trạng thái đăng nhập (`authenticatedByProvider`), kết quả smoke test (`smokePassedByProvider`), surface descriptor (`providerSurfaceIds`), IPC (`launcher:list-providers`, `launcher:switch-provider`) và Launcher UI (`SetupSurface`, `.provider-switcher` trong `BrowserSurface`) đã hoạt động động theo `BrowserProviderRegistry`.
4. **Cổng Kiểm tra Kiến trúc (`scripts/check-circular-deps.js`, `tests/m365-architecture-integrity.test.ts` & `tests/web-turn-engine.test.ts`)**:
   - `scripts/check-circular-deps.js` và `tests/m365-architecture-integrity.test.ts` tự động quét `src/adapters/web` và toàn bộ thư mục provider dưới `src/adapters/`.
   - Đảm bảo 0 circular dependency, không import ngược từ shared layer, không chứa alias `M365*` cũ trong `src/adapters/web/`, và mọi facade `index.ts` đều kế thừa `WebProviderAdapter` mà không tự gọi hàm điều phối cấp thấp.

---

## 7. Checklist Triển khai

### Provider & Integration contract

- [ ] `<Provider>ModelProvider` kế thừa `BaseModelProvider` và được đăng ký trong `ModelRegistry.defaultInstance`.
- [ ] Facade `<Provider>Adapter` kế thừa `WebProviderAdapter`, không tự viết lại `runTurn`, và được đăng ký trong `AdapterRegistry.defaultInstance` với **đúng `id` của `ModelProvider`**.
- [ ] `WebProviderDefinition` khai báo đúng `id`, `assistantName`, `logPrefix`.
- [ ] `conversation.resolveConversationKey` trả về khóa ổn định (SHA-256 hex) và không làm lộ định danh nhạy cảm.
- [ ] `browser.launcherProviderId` và `browser.connectorIdentity` khớp với `BaseBrowserProvider` đăng ký trong `createDefaultProviderRegistry()`.
- [ ] Partition của `BaseBrowserProvider` khớp validator trong `src/launcher-browser-host.ts` (ví dụ `persist:codex-web-<provider>`).
- [ ] `browser.executeTurn` không emit raw chunk ra Codex và trả về `{ rawResponse, conversationId? }`; tôn trọng `retain === false` cho ephemeral turns.
- [ ] Attachment chỉ được gửi ở attempt đầu tiên (`attempt === 0`).
- [ ] Format retry tiếp tục trên hội thoại hiện tại (`attempt > 0` có `isNewConversation = false`).
- [ ] Mọi policy khác mặc định đều có lý do rõ ràng và test tương ứng.

### Quality gates

Chạy đúng bộ script của repository (lưu ý dùng `bun run test`, không chạy `bun test` trần vì sẽ chạy nhầm `launcher/tests/*.test.cjs` bằng Bun thay vì Node test runner):

```bash
git diff --check
bun run check:architecture
bun test tests/web-turn-engine.test.ts tests/m365-architecture-integrity.test.ts
bun run typecheck && bun run launcher:typecheck
bun run test
bun run launcher:test
bun run build && bun run launcher:build
```

Nếu typecheck hoặc full regression suite đã đỏ từ baseline trước khi thêm provider, phải ghi nhận riêng các lỗi có sẵn. Không được coi architecture gate xanh là bằng chứng toàn repository đã xanh.
