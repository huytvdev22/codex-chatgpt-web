# Hướng Dẫn Thiết Kế & Tích Hợp Web Adapter Mới

Tài liệu này định nghĩa tư duy thiết kế và ranh giới kiến trúc khi thêm một Web Provider mới vào `codex-chatgpt-web`.

---

## 1. Tư duy Thiết kế Cốt lõi

Toàn bộ các Web Provider dùng chung một đường ống điều phối duy nhất. Khi thêm provider mới, bạn **không xây lại luồng chạy**, mà chỉ **cắm (plug-in) phần tương tác trình duyệt đặc thù** vào khung có sẵn:

```text
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
  → Viết Browser Worker & Capability Picker (chỉ xử lý UI trang đích)
  → Khai báo WebProviderDefinition (gắn các Driver + chọn Policy)
  → Kế thừa WebProviderAdapter
  → Đăng ký Model (src/models/) & Surface (Launcher)
  → Kiểm chứng qua Contract & Architecture Gates
```

### Các bước tích hợp thực tế

1. **Khảo sát giao diện provider**
   - User đăng nhập và mở trực tiếp giao diện web cần tích hợp bằng browser profile dành cho provider.
   - Dùng DevTools để xác định URL hội thoại, composer, nút gửi, nút dừng, vùng câu trả lời, trạng thái đang sinh nội dung, model/reasoning picker và khu vực upload nếu có.
   - Ghi nhận selector ở nhiều trạng thái: trang mới, đang trả lời, trả lời xong, hội thoại cũ, lỗi đăng nhập và giới hạn sử dụng.
   - Ưu tiên thuộc tính ổn định như `data-testid`, `aria-label`, `role` hoặc cấu trúc semantic; tránh class CSS sinh động và selector phụ thuộc vị trí.
   - Không lưu cookie, access token, nội dung hội thoại hoặc thông tin đăng nhập vào mã nguồn và tài liệu.

2. **Tạo provider adapter**
   - Tạo thư mục `src/adapters/<provider>/` với facade `index.ts` và browser worker.
   - Chỉ thêm `selectors.ts`, capability picker, conversation store hoặc attachment handler khi giao diện provider cần các chức năng tương ứng.
   - Browser worker chịu trách nhiệm thao tác DOM, chờ stream hoàn tất và trả về `rawResponse` cùng `conversationId` nếu có.

3. **Khai báo contract dùng chung**
   - Tạo `WebProviderDefinition` với conversation, browser và các driver tùy chọn.
   - Chọn policy theo hành vi thực tế của provider; ưu tiên mặc định của `WebTurnEngine`.
   - Bảo đảm raw stream không được emit ra ngoài trước khi shared protocol hoàn tất validation.

4. **Đăng ký vào hệ thống**
   - Thêm provider và model route trong `src/models/`.
   - Đăng ký adapter tại server router.
   - Thêm Launcher surface, browser partition, descriptor và luồng đăng nhập khi provider cần browser riêng.
   - Cập nhật Launcher UI hoặc model picker nếu user cần chọn provider từ giao diện.

5. **Kiểm chứng trên giao diện thật**
   - Kiểm tra gửi prompt lần đầu, tiếp tục hội thoại, format retry, abort và khôi phục sau lỗi.
   - Nếu có model/reasoning picker hoặc attachment, kiểm tra riêng từng trạng thái và xác nhận selector không phụ thuộc ngôn ngữ giao diện khi có thể.
   - Sau mỗi lần website thay đổi giao diện, khảo sát lại DOM và cập nhật selector trước khi thay đổi shared Web layer.

6. **Bổ sung test và chạy quality gates**
   - Thêm contract test cho facade, conversation lifecycle, retry và các đặc thù của provider.
   - Chạy architecture gate, provider tests, typecheck, full test và build theo checklist cuối tài liệu.

---

## 2. Phân tách Trách nhiệm (Shared vs. Provider)

| Tầng | Sở hữu | Tuyệt đối KHÔNG chứa |
| :--- | :--- | :--- |
| **Shared Layer** (`src/adapters/web/`) | - Điều phối vòng đời lượt chạy (`WebTurnEngine`, `runtime-lifecycle.ts`)<br>- Chuẩn hóa payload & biên dịch prompt (`normalization/`, `prompt/`)<br>- Giao thức `<webResponse>`, parser, validator, format-retry, event emission (`protocol/`)<br>- Chuẩn hóa & ánh xạ công cụ (`tools/`, `WebToolBridge`)<br>- Chống lặp vô hạn & lưu trữ hội thoại (`execution/`, `conversation/`) | - Selector DOM hoặc URL của bất kỳ provider nào<br>- Logic nhánh `if (provider === ...)`<br>- Import ngược từ `src/adapters/<provider>/` |
| **Provider Layer** (`src/adapters/<provider>/`) | - `index.ts`: Khai báo `WebProviderDefinition` & kế thừa `WebProviderAdapter`<br>- `browser-worker.ts`: Điều khiển trang, gửi prompt, đọc `rawResponse`<br>- `capability-picker.ts`: Chọn model / mức tư duy trên UI<br>- `selectors.ts` & `conversation-store.ts`: Selector, URL và khóa hội thoại | - Tự viết lại `runTurn()`<br>- Tự quản lý Launcher lifecycle, trừ ngoại lệ được phê duyệt với `manageLauncherLeaseInEngine: false` (M365 là trường hợp tham chiếu)<br>- Tự gọi parser, validator, retry hay emit event giao thức |

---

## 3. Năm Hợp đồng Driver trong `WebProviderDefinition`

Một provider được mô tả trọn vẹn qua 5 nhóm driver trong `src/adapters/web/definition.ts`:

1. **`conversation` (`WebConversationDriver`)**:
   - Xác định khóa hội thoại ổn định bằng `buildWebConversationKey` hoặc hàm conversation-key đặc thù của provider.
   - Dùng `GenericConversationStore` khi cần ánh xạ khóa nội bộ sang `conversationId` của website.
   - Quyết định khi nào tái sử dụng hội thoại cũ (`resolveState`) và khi nào gắn kết surface vào Launcher lúc kết thúc lượt (`resolveEndTurnBinding`).
2. **`capability` (`WebCapabilityPickerDriver`)**:
   - Ánh xạ mức suy luận từ Codex (`low` / `medium` / `high`) sang chế độ tương ứng trên giao diện Web.
3. **`attachments` (`WebAttachmentDriver` - tuỳ chọn)**:
   - Trích xuất hình ảnh đính kèm ở lần gửi đầu tiên (`attempt === 0`). Không gửi lại ảnh ở các vòng retry định dạng.
4. **`browser` (`WebBrowserDriver`)**:
   - Nhận `Page` từ Engine, thực thi thao tác trên DOM (chọn capability -> đính kèm ảnh -> điền composer -> gửi -> trích xuất câu trả lời) và chỉ trả về `{ rawResponse, conversationId }`.
   - Bắt buộc khai báo `launcherProviderId` và `connectorIdentity` để Launcher định tuyến đúng provider và surface.
   - Có thể khai báo `descriptorPath`, `descriptorSubdirs` và `resolveSurfaceId` khi provider cần tìm descriptor hoặc tái sử dụng surface theo quy tắc riêng.
5. **`response` (`WebResponseDriver` - tuỳ chọn)**:
   - Tinh chỉnh hậu xử lý nếu trang web có đặc thù riêng: lọc rác UI bao quanh (`sanitizeRawResponse`), cho phép văn bản tự nhiên khi không có công cụ (`tolerantNaturalTextFallback`), hoặc tính toán token (`computeUsage`).
   - Có thể tùy chỉnh phân loại lỗi validation, call ID và chi tiết sự kiện kết thúc, nhưng không tự gọi parser, validator hay event emitter.

---

## 4. Các Nguyên lý Xử lý Trình duyệt & Phản hồi

1. **Cách ly Luồng Thô (Raw Stream Quarantine)**:
   - Trong lúc trình duyệt đang stream câu trả lời, worker chỉ thu thập dữ liệu nội bộ (có thể dùng `FastPathStreamBuffer`, `SemanticMarkdownBuffer`, `webHtmlToMarkdown`), **không** phát trực tiếp chunk thô ra Codex trước khi `WebTurnEngine` hoàn tất kiểm duyệt `<webResponse>`.
2. **Trích xuất Đa tầng (chiến lược khuyến nghị, không phải contract bắt buộc)**:
   - **Ưu tiên 1:** Bắt nội dung nguyên bản từ nút Copy của khối code Markdown ngoài cùng (qua clipboard hook nội bộ trong trang, không chạm OS clipboard của người dùng).
   - **Ưu tiên 2:** Nếu không có nút Copy, trích xuất từ vùng DOM câu trả lời và loại bỏ các thành phần trang trí UI.
   - Provider có thể dùng chiến lược khác nếu website không có nút Copy hoặc DOM streaming không ổn định, miễn `executeTurn` trả về `rawResponse` đầy đủ và không phát nội dung chưa kiểm duyệt.
3. **Tự sửa lỗi trên cùng Hội thoại (In-Place Format Retry)**:
   - Khi phản hồi vi phạm giao thức `<webResponse>`, `WebTurnEngine` tự động gửi prompt nhắc sửa lỗi ngay trên `conversationId` vừa tạo (`attempt > 0` luôn có `isNewConversation = false`).

---

## 5. Quyết định Chính sách Vòng đời (`WebProviderPolicies`)

Mỗi provider chọn tổ hợp chính sách phù hợp thay vì viết câu lệnh điều kiện:

- **`launcherFailureMode`**:
  - `"fail-closed"` (mặc định): Bắt buộc chạy trên trình duyệt của Launcher; báo lỗi ngay nếu mất kết nối CDP.
  - `"fallback-local"`: Cho phép rơi về `LocalBrowserRuntime` khi Launcher không chạy.
- **`manageLauncherLeaseInEngine`**:
  - `true` (mặc định): Engine quản lý lease `start`/`end` bao trọn cả lượt chạy.
  - `false`: Ngoại lệ có chủ đích, chỉ dùng khi worker bắt buộc tự quản lý lease theo từng attempt. M365 là trường hợp tham chiếu hiện tại.
- **`closeLauncherConnectionOnEnd`**:
  - `true` (mặc định): Đóng kết nối Playwright CDP trong khối `finally`.
  - `false`: Giữ kết nối mở sau khi báo `phase=end` (như Google AI Studio).
- **`emitErrorEventOnFailure` & `rethrowError`**:
  - Quyết định việc phát sự kiện `{ type: "error" }` tại Engine hay để tầng Server xử lý ngoại lệ, tránh nhân đôi lỗi trên stream.
- **`errorMessagePrefix` & `abortedTurnMessage`**:
  - Tùy chỉnh tiền tố lỗi phát ra stream và thông báo `AbortError`; chỉ đặt khi provider cần thông điệp đặc thù.
- **`maxFormatRetries`**:
  - Số lần gửi lại prompt sửa định dạng, mặc định là `2`; có thể là số cố định hoặc hàm đọc cấu hình runtime.
- **`enableEarlyExitOnFinalAnswer` & `enableToolLoopGuard`**:
  - Ngắt sớm nếu hội thoại đã kết thúc bằng câu trả lời của assistant và bảo vệ chống lặp vô hạn công cụ (`conversationGuard`).
- **`traceIdOptions`**:
  - Tùy chỉnh số byte và encoding (`base64url` hoặc `hex`) của trace ID khi provider hoặc Launcher có contract riêng.

### Nguyên tắc chọn policy

- Bắt đầu từ mặc định của `WebTurnEngine`; chỉ khai báo policy khi hành vi provider thực sự khác mặc định.
- Không dùng policy để che giấu lỗi worker hoặc bỏ qua validation.
- Mọi ngoại lệ lifecycle cần có contract test và ghi rõ lý do trong troubleshooting.

---

## 6. Điểm chạm Tích hợp Hệ thống

Ngoài thư mục `src/adapters/<provider>/`, một provider mới chạm vào **ít nhất 4 nhóm điểm tích hợp**:

1. **Model Registry (`src/models/model-registry.ts` & `src/models/model-catalog.ts`)**: Khai báo `ModelProviderId`, danh sách model slugs, giới hạn ngữ cảnh và các mức reasoning.
2. **Server Router (`src/server.ts`)**: Định tuyến model của provider vào `adapter.runTurn(parsed, incoming, emit)`.
3. **Launcher Surface (`launcher/electron/` & `src/launcher-browser-host.ts`)**: Cấp phát phân vùng trình duyệt độc lập (`persist:codex-<provider>`) và quản lý tab qua Surface Manager.
4. **Cổng Kiểm tra Kiến trúc (`tests/m365-architecture-integrity.test.ts` & `tests/web-turn-engine.test.ts`)**:
   - `tests/m365-architecture-integrity.test.ts` giữ tên lịch sử nhưng hiện kiểm tra shared Web layer và toàn bộ provider facade.
   - Đảm bảo không có phụ thuộc vòng, không import ngược từ shared layer, và facade của provider chỉ kế thừa `WebProviderAdapter` mà không tự điều phối cấp thấp.

Tùy provider, có thể cần cập nhật thêm Launcher UI, browser-host descriptor, setup/login flow, model selection UI, export công khai và fixture kiểm thử. Không mặc định rằng bốn điểm trên là toàn bộ phạm vi thay đổi.

---

## 7. Checklist Triển khai

### Provider contract

- [ ] Facade kế thừa `WebProviderAdapter`, không tự viết lại `runTurn`.
- [ ] `WebProviderDefinition` khai báo đúng `id`, `assistantName`, `logPrefix`.
- [ ] `conversation.resolveConversationKey` trả về khóa ổn định và không làm lộ định danh nhạy cảm.
- [ ] `browser.launcherProviderId` và `browser.connectorIdentity` khớp Launcher.
- [ ] `browser.executeTurn` không emit raw chunk ra Codex và trả về `{ rawResponse, conversationId? }`.
- [ ] Attachment chỉ được gửi ở attempt đầu tiên.
- [ ] Retry tiếp tục trên hội thoại hiện tại thay vì tạo hội thoại mới.
- [ ] Mọi policy khác mặc định đều có lý do và test tương ứng.

### Quality gates

Chạy theo thứ tự để phân biệt lỗi kiến trúc, lỗi provider và lỗi baseline toàn repository:

```bash
git diff --check
bun run check:architecture
bun test tests/web-turn-engine.test.ts tests/m365-architecture-integrity.test.ts
bun run typecheck
bun test
bun run build
```

Nếu typecheck hoặc full regression suite đã đỏ từ baseline trước khi thêm provider, phải ghi nhận riêng các lỗi có sẵn. Không được coi architecture gate xanh là bằng chứng toàn repository đã xanh.
