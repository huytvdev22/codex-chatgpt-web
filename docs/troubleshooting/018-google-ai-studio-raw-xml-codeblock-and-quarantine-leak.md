# [ISSUE-018] Google AI Studio Trả Về Khối Code Block Bị Dính Tiền Tố Rác Và Lộ Thẻ XML Trực Tiếp Lên Codex

> **Status:** ⏳ Chờ User Test & Confirm  
> **Providers:** `google-ai-studio`, `playwright`, `m365-copilot-protocol`  
> **Keywords:** `ms-code-block`, `mat-expansion-panel-header`, `webResponse`, `Quarantine streaming`, `upstream_stall_timeout`

## ⚡ TL;DR (AI Đọc Nhanh 5 Giây)
- **Triệu chứng:** Phản hồi từ Google AI Studio trên UI Codex bị hiển thị thô cả tiền tố rác và thẻ XML (`code Codedownloadcontent_copyexpand_lessless<webResponse>...`), nội dung bị lặp lại 3 lần, cuối cùng bị lỗi `Incomplete response returned, reason: upstream_stall_timeout`.
- **Nguyên nhân gốc rễ:** 
  1. **Dính rác UI header:** Giao diện Google AI Studio render khối 4-backtick thành component `<ms-code-block>`, chứa `<mat-expansion-panel-header>` với text của các nút download, copy, icons. Hàm scraper cũ lấy `textContent` toàn khối nên bị dính chùm chuỗi rác `code Codedownloadcontent_copyexpand_lessless` trước `<webResponse>`.
  2. **Vi phạm Quarantine Streaming:** Adapter AI Studio cấu hình callback `onChunk` emit trực tiếp `text_delta` thô ra Codex trong khi model đang stream thay vì giữ lại kiểm tra tính hợp lệ (Quarantine) như chuẩn M365 Copilot.
  3. **Vòng lặp retry lặp lại 3 lần:** Do bị dính chuỗi rác trước `<webResponse>`, hàm `parseStrictM365Response` không nhận diện được root open envelope (`framed.startsWith("<webResponse>")` trả về false) và ném lỗi `MISSING_RESPONSE_ENVELOPE`. Adapter kích hoạt format retry tối đa 3 lần, mỗi lần lại stream rác ra Codex UI và kết thúc bằng stall timeout.
- **Cách sửa:** 
  1. Trong `src/adapters/google-ai-studio/browser-worker.ts`: Nâng cấp DOM Scraper `readLatestCleanResponse` clone target turn, bóc sạch toàn bộ junk selectors (`mat-expansion-panel-header`, `button`, `.actions-container`, `.header-content`, `ms-thought-chunk`, icons); đồng thời gắn `data-codex-turn-baseline` trước khi submit prompt để chỉ đọc đúng turn mới sinh.
  2. Trong `src/adapters/google-ai-studio/index.ts`: Bật chế độ Quarantine (`onChunk: () => {}`), không emit raw stream ra Codex. Bổ sung hàm `sanitizeAIStudioResponse` cắt sạch mọi tiền tố rác trước `<webResponse>` và hậu tố sau `</webResponse>`. Sau khi parse strict response, chỉ emit nội dung markdown sạch (`protocolResult.content`) hoặc tool call events. Nếu fallback, dọn sạch thẻ `<webResponse>` trước khi emit.

---

## 🛠️ Chi Tiết Triển Khai & Sửa Đổi

### 1. `src/adapters/google-ai-studio/browser-worker.ts`
- **Đánh dấu Turn Baseline:** Trước khi click Run / gửi prompt, đánh dấu `data-codex-turn-baseline="true"` lên toàn bộ `ms-chat-turn` hiện có trên DOM.
- **Scraper không dính rác:** `readLatestCleanResponse` chỉ nhắm vào turn model mới nhất không thuộc baseline cũ (`ms-chat-turn:not([data-codex-turn-baseline])`).
- **Clone & Strip Junk Nodes:** Clone target turn và loại bỏ toàn bộ các element rác:
  - `ms-thought-chunk`: Suy nghĩ nội tâm.
  - `mat-expansion-panel-header`, `.actions-container`, `.projected-actions-wrapper`, `.header-content`: Rác UI chứa download/copy buttons.
  - `button`, `.mat-expansion-indicator`, `.title-icon`, `mat-icon`, `.material-symbols-outlined`: Toàn bộ nút thao tác và icons.
  - `ms-chat-turn-footer`, `.turn-footer`: Thumbs up/down, feedback.
- Lấy `clone.textContent` sạch 100%, bảo toàn trọn vẹn thụt lề và ngắt dòng trong `<pre><code>`.

### 2. `src/adapters/google-ai-studio/index.ts`
- **Quarantine Streaming:** Đặt `onChunk: () => {}` trong `worker.executeTurn` để ngăn raw XML stream bắn thẳng ra ngoài Codex UI.
- **Defense-in-depth Sanitizer (`sanitizeAIStudioResponse`):**
  - Tự động tìm vị trí `<webResponse>` và cắt sạch toàn bộ rác dẫn trước (nếu có).
  - Tự động tìm vị trí `</webResponse>` và cắt sạch toàn bộ rác kéo theo sau (nếu có).
- **Strict Response Dispatch:**
  - `kind === "final_answer"`: emit duy nhất `protocolResult.content` và `done`.
  - `kind === "tool_calls"`: emit `tool_call_start`, `tool_call_delta`, `tool_call_end` và `done`.
  - Fallback: dọn sạch thẻ `<webResponse>` trước khi emit.

### 3. `tests/google-ai-studio.test.ts`
- Bổ sung 3 unit tests mới kiểm tra:
  - `sanitizeAIStudioResponse` bóc sạch tiền tố `code Codedownloadcontent_copyexpand_lessless` và parse thành công `final_answer`.
  - `sanitizeAIStudioResponse` bóc sạch rác khi có `tool_call`.
  - Giữ nguyên chuỗi hợp lệ.
