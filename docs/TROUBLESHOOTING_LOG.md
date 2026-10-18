# Nhật Ký Xử Lý Lỗi & Bài Học Kinh Nghiệm (Troubleshooting & Bug Log)

Tài liệu này lưu trữ toàn bộ các lỗi đã phát hiện, nguyên nhân gốc rễ, giải pháp đã áp dụng và trạng thái xác nhận (confirm) từ người dùng. Mỗi khi sửa xong một lỗi, nội dung sẽ được ghi lại tại đây để đối chiếu và tra cứu lại trong các lần làm việc tiếp theo.

---

## Danh Sách Lỗi Đã Ghi Nhận

| STT | Mã / Tên Lỗi | Provider | Ngày sửa | Trạng thái |
| :--- | :--- | :--- | :--- | :--- |
| **01** | [Mỗi tin nhắn trên Codex tạo ra một đoạn chat mới trên Web](#01-mỗi-tin-nhắn-trên-codex-tạo-ra-một-đoạn-chat-mới-trên-web) | Qwen Web, ChatGPT Web | 18/10/2026 | ⏳ Chờ User Test & Confirm |
| **02** | [Lỗi kết nối Launcher: Provider is invalid (HTTP 400)](#02-lỗi-kết-nối-launcher-provider-is-invalid-http-400) | Qwen Web | 18/10/2026 | ⏳ Chờ User Test & Confirm |
| **03** | [Lỗi Browser Partition không hợp lệ cho Qwen](#03-lỗi-browser-partition-không-hợp-lệ-cho-qwen) | Qwen Web | 18/10/2026 | ⏳ Chờ User Test & Confirm |

---

## Chi Tiết Từng Lỗi

### 01. Mỗi tin nhắn trên Codex tạo ra một đoạn chat mới trên Web

- **Provider ảnh hưởng:** `qwen-web`, `chatgpt-web`
- **Ngày sửa:** 18/10/2026
- **Trạng thái:** ⏳ Chờ User Test & Confirm

#### 1. Hiện tượng (Symptom)
- Khi chat từ Codex, ở mỗi câu hỏi người dùng gửi đi (turn 1, turn 2, turn 3...), trên giao diện web (`chat.qwen.ai` hoặc `chatgpt.com`) lại xuất hiện thêm một cuộc trò chuyện mới ở sidebar thay vì tiếp tục trong cùng một cuộc trò chuyện đã tạo ở lượt đầu tiên.

#### 2. Nguyên nhân gốc rễ (Root Cause)
1. **Sai lệch logic xác định `isNewConversation`:**
   - Trong `src/adapters/qwen-web/index.ts` và `src/adapters/chatgpt-web/index.ts`, hàm `hasActualPriorAssistantReply(parsed.context.messages)` được dùng để kiểm tra xem có tin nhắn trả lời trước đó của trợ lý hay không.
   - Khi Codex gửi tin nhắn tiếp theo trong cùng một thread, ngữ cảnh tin nhắn đôi khi không chứa role `assistant` dạng văn bản thông thường (ví dụ các turn tạo tiêu đề thread, reasoning, v.v.), dẫn đến `hasActualPriorAssistantReply()` trả về `false`.
   - Khi đó, code gán:
     ```typescript
     const isNewConversation = !hasPriorAssistantReply;
     const rawExistingConvId = isNewConversation ? undefined : ...;
     ```
     Điều này khiến `existingConversationId` bị xóa thành `undefined`, bỏ qua hoàn toàn `conversationId` đã được lưu trong store hoặc lease từ Launcher.
2. **Worker tự động nhảy về trang chủ:**
   - Khi `isNewConversation === true`, worker gọi `page.goto("https://chat.qwen.ai/")` để reset trang, làm mất cuộc trò chuyện hiện tại và sinh ra chat mới.
3. **Chưa có polling theo dõi URL chuyển đổi SPA:**
   - Khi gửi tin nhắn đầu tiên từ trang chủ, Qwen Web đổi URL sang `/c/<uuid>` thông qua SPA client routing (`pushState`). Worker trước đây chỉ đọc `page.url()` 1 lần duy nhất sau khi stream xong, nếu SPA chưa kịp đổi URL thì `conversationId` không được ghi nhận, dẫn đến Launcher đóng tab thay vì giữ lại (`retain`).

#### 3. Cách khắc phục (Solution)
1. **Sửa logic nhận diện phiên hội thoại:**
   - Chỉ xem là phiên mới nếu **thực sự chưa có phản hồi trợ lý VÀ thread này chưa từng có cuộc trò chuyện nào được lưu**:
     ```typescript
     const storedConvId = defaultQwenConversationStore.getConversationId(threadId);
     const rawExistingConvId = leaseConversationId || storedConvId;
     const existingConversationId = isValidQwenConversationId(rawExistingConvId || "") ? rawExistingConvId : undefined;

     const hasPriorAssistantReply = hasActualPriorAssistantReply(parsed.context.messages);
     const isNewConversation = !hasPriorAssistantReply && !existingConversationId;
     activeConversationId = existingConversationId;
     ```
2. **Bổ sung Polling và Fallback an toàn trong Worker:**
   - Liên tục theo dõi `page.url()` trong suốt vòng lặp stream.
   - Sau khi stream xong, polling trong 3 giây để chờ URL đổi sang `/c/<uuid>`.
   - Fallback đọc ID từ sidebar DOM (`nav a[href*="/c/"]`).
   - Nếu tab đang ở sẵn `/c/<id>`, giữ nguyên tab và tiếp tục gửi tin nhắn, tuyệt đối không gọi `page.goto()`.
3. **Bảo toàn binding trong Launcher:**
   - Thêm fallback `rawId = conversationId || parseQwenConversationId(liveUrl) || tab.conversationId` để đảm bảo tab sau khi hoàn tất turn luôn được bind và giữ lại ở trạng thái `ready` cho lượt sau.

#### 4. Các file liên quan
- `src/adapters/qwen-web/index.ts`
- `src/adapters/qwen-web/qwen-browser-worker.ts`
- `src/adapters/qwen-web/selectors.ts`
- `src/adapters/chatgpt-web/index.ts`
- `launcher/electron/browser-host.cjs`
- `launcher/electron/qwen-surface-manager.cjs`
- `tests/qwen-web-adapter.test.ts`

---

### 02. Lỗi kết nối Launcher: Provider is invalid (HTTP 400)

- **Provider ảnh hưởng:** `qwen-web`
- **Ngày sửa:** 18/10/2026
- **Trạng thái:** ⏳ Chờ User Test & Confirm

#### 1. Hiện tượng (Symptom)
- Khi gửi tin nhắn qua `qwen-web`, client báo lỗi `stream disconnected before completion: [qwen-adapter] Không thể kết nối với Launcher browser tab`.
- Terminal Launcher báo lỗi: `HTTP 400: provider is invalid`.

#### 2. Nguyên nhân gốc rễ (Root Cause)
- Trong `launcher/electron/control-server.cjs` và `launcher/electron/browser-host.cjs`, danh sách whitelist cho `provider` chỉ chấp nhận `chatgpt`, `m365`, `gemini` mà chưa bổ sung `qwen`.

#### 3. Cách khắc phục (Solution)
- Bổ sung `provider !== "qwen"` vào danh sách hợp lệ tại `control-server.cjs` dòng 184 và `browser-host.cjs` dòng 2814.

#### 4. Các file liên quan
- `launcher/electron/control-server.cjs`
- `launcher/electron/browser-host.cjs`

---

### 03. Lỗi Browser Partition không hợp lệ cho Qwen

- **Provider ảnh hưởng:** `qwen-web`
- **Ngày sửa:** 18/10/2026
- **Trạng thái:** ⏳ Chờ User Test & Confirm

#### 1. Hiện tượng (Symptom)
- Launcher báo lỗi: `Launcher browser descriptor identifies an unexpected browser partition` khi helper cố gắng kết nối tới session Qwen.

#### 2. Nguyên nhân gốc rễ (Root Cause)
- Trong `src/launcher-browser-host.ts`, mảng `allowedPartitions` chỉ cho phép `persist:codex-web-gpt-chatgpt` và `persist:codex-m365-copilot`, chưa có partition của Qwen.

#### 3. Cách khắc phục (Solution)
- Bổ sung `persist:codex-web-gpt-qwen` vào `allowedPartitions` trong `src/launcher-browser-host.ts` và build lại `.launcher-runtime/browser-helper.cjs`.

#### 4. Các file liên quan
- `src/launcher-browser-host.ts`
- `.launcher-runtime/browser-helper.cjs`
- `scripts/build-browser-helper.ts`
