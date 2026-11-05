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

---

## 2. Phân tách Trách nhiệm (Shared vs. Provider)

| Tầng | Sở hữu | Tuyệt đối KHÔNG chứa |
| :--- | :--- | :--- |
| **Shared Layer** (`src/adapters/web/`) | - Điều phối vòng đời lượt chạy (`WebTurnEngine`, `runtime-lifecycle.ts`)<br>- Chuẩn hóa payload & biên dịch prompt (`normalization/`, `prompt/`)<br>- Giao thức `<webResponse>`, parser, validator, format-retry, event emission (`protocol/`)<br>- Chuẩn hóa & ánh xạ công cụ (`tools/`, `WebToolBridge`)<br>- Chống lặp vô hạn & lưu trữ hội thoại (`execution/`, `conversation/`) | - Selector DOM hoặc URL của bất kỳ provider nào<br>- Logic nhánh `if (provider === ...)`<br>- Import ngược từ `src/adapters/<provider>/` |
| **Provider Layer** (`src/adapters/<provider>/`) | - `index.ts`: Khai báo `WebProviderDefinition` & kế thừa `WebProviderAdapter`<br>- `browser-worker.ts`: Điều khiển trang, gửi prompt, đọc `rawResponse`<br>- `capability-picker.ts`: Chọn model / mức tư duy trên UI<br>- `selectors.ts` & `conversation-store.ts`: Selector, URL và khóa hội thoại | - Tự viết lại `runTurn()`<br>- Tự gọi `startLauncherBrowserTurn` / `endLauncherBrowserTurn`<br>- Tự gọi parser, validator, retry hay emit event giao thức |

---

## 3. Năm Hợp đồng Driver trong `WebProviderDefinition`

Một provider được mô tả trọn vẹn qua 5 nhóm driver trong `src/adapters/web/definition.ts`:

1. **`conversation` (`WebConversationDriver`)**:
   - Xác định khóa hội thoại ổn định (`deriveStableConversationKey`) và đồng bộ `conversationId` qua `GenericConversationStore`.
   - Quyết định khi nào tái sử dụng hội thoại cũ (`resolveState`) và khi nào gắn kết surface vào Launcher lúc kết thúc lượt (`resolveEndTurnBinding`).
2. **`capability` (`WebCapabilityPickerDriver`)**:
   - Ánh xạ mức suy luận từ Codex (`low` / `medium` / `high`) sang chế độ tương ứng trên giao diện Web.
3. **`attachments` (`WebAttachmentDriver` - tuỳ chọn)**:
   - Trích xuất hình ảnh đính kèm ở lần gửi đầu tiên (`attempt === 0`). Không gửi lại ảnh ở các vòng retry định dạng.
4. **`browser` (`WebBrowserDriver`)**:
   - Nhận `Page` từ Engine, thực thi thao tác trên DOM (chọn capability -> đính kèm ảnh -> điền composer -> gửi -> trích xuất câu trả lời) và chỉ trả về `{ rawResponse, conversationId }`.
5. **`response` (`WebResponseDriver` - tuỳ chọn)**:
   - Tinh chỉnh hậu xử lý nếu trang web có đặc thù riêng: lọc rác UI bao quanh (`sanitizeRawResponse`), cho phép văn bản tự nhiên khi không có công cụ (`tolerantNaturalTextFallback`), hoặc tính toán token (`computeUsage`).

---

## 4. Các Nguyên lý Xử lý Trình duyệt & Phản hồi

1. **Cách ly Luồng Thô (Raw Stream Quarantine)**:
   - Trong lúc trình duyệt đang stream câu trả lời, worker chỉ thu thập dữ liệu nội bộ (có thể dùng `FastPathStreamBuffer`, `SemanticMarkdownBuffer`, `webHtmlToMarkdown`), **không** phát trực tiếp chunk thô ra Codex trước khi `WebTurnEngine` hoàn tất kiểm duyệt `<webResponse>`.
2. **Trích xuất Đa tầng (Copy-Button Salvage → DOM Fallback)**:
   - **Ưu tiên 1:** Bắt nội dung nguyên bản từ nút Copy của khối code Markdown ngoài cùng (qua clipboard hook nội bộ trong trang, không chạm OS clipboard của người dùng).
   - **Ưu tiên 2:** Nếu không có nút Copy, trích xuất từ vùng DOM câu trả lời và loại bỏ các thành phần trang trí UI.
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
  - `false`: Chỉ dùng khi worker bắt buộc tự quản lý lease theo từng attempt (như M365).
- **`closeLauncherConnectionOnEnd`**:
  - `true` (mặc định): Đóng kết nối Playwright CDP trong khối `finally`.
  - `false`: Giữ kết nối mở sau khi báo `phase=end` (như Google AI Studio).
- **`emitErrorEventOnFailure` & `rethrowError`**:
  - Quyết định việc phát sự kiện `{ type: "error" }` tại Engine hay để tầng Server xử lý ngoại lệ, tránh nhân đôi lỗi trên stream.
- **`enableEarlyExitOnFinalAnswer` & `enableToolLoopGuard`**:
  - Ngắt sớm nếu hội thoại đã kết thúc bằng câu trả lời của assistant và bảo vệ chống lặp vô hạn công cụ (`conversationGuard`).

---

## 6. Điểm chạm Tích hợp Hệ thống

Ngoài thư mục `src/adapters/<provider>/`, một provider mới chỉ chạm vào 4 điểm đăng ký:

1. **Model Registry (`src/models/model-registry.ts` & `src/models/model-catalog.ts`)**: Khai báo `ModelProviderId`, danh sách model slugs, giới hạn ngữ cảnh và các mức reasoning.
2. **Server Router (`src/server.ts`)**: Định tuyến model của provider vào `adapter.runTurn(parsed, incoming, emit)`.
3. **Launcher Surface (`launcher/electron/` & `src/launcher-browser-host.ts`)**: Cấp phát phân vùng trình duyệt độc lập (`persist:codex-<provider>`) và quản lý tab qua Surface Manager.
4. **Cổng Kiểm tra Kiến trúc (`tests/m365-architecture-integrity.test.ts` & `tests/web-turn-engine.test.ts`)**:
   - Đảm bảo `bun run check:architecture` xanh: không có phụ thuộc vòng, không import ngược từ shared layer, và facade của provider chỉ kế thừa `WebProviderAdapter` mà không tự điều phối cấp thấp.
