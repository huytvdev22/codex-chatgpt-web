# 109 — AI Studio chỉ trả về `Model HH:MM AM/PM\n\nThinking` trên Telegram khi Streaming

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Phạm vi / Providers:** `ai-studio`, `assistant`, `streaming`, `playwright`

## ⚡ TL;DR
- **Triệu chứng:** Khi dùng model `ai-studio/gemini-4-hydrogen` trên Telegram Bot (`streamIncremental=true`), bot trả kết quả cụt lủn `Model 1:42 PM\n\nThinking` dù trên web AI Studio đã sinh xong đầy đủ câu trả lời.
- **Nguyên nhân gốc rễ:** Google AI Studio đổi thẻ tiêu đề từ `h3.author-label` sang `<div role="heading" aria-level="3" class="author-label">` và đặt `<ms-chat-loading-indicator>Thinking</ms-chat-loading-indicator>` ngay trong `.turn-content` khi đang suy nghĩ; `AiStudioDomObserver` chưa xóa 2 node này nên phát sớm chuỗi `"Model ... Thinking"` lên `AssistantStreamGate`, rồi cuối turn `finalizeAsFinalAnswer()` thấy `LCP < 70%` so với đáp án thật nên trả `""` và nuốt mất câu trả lời thật.
- **Cách sửa:** Cập nhật `AiStudioDomObserver.captureStatus()` xóa `.author-label`, `ms-chat-loading-indicator` (và đo `lightweightLen` ở fast-path theo `ms-prompt-chunk`), giữ `lastObservedText` qua chu kỳ fast-path; đồng thời nâng cấp `AssistantStreamGate.finalizeAsFinalAnswer()` căn neo bỏ qua inline markdown ở đầu câu và fallback nối đáp án thật nếu snapshot đầu bị lệch hoàn toàn.

## Chi tiết thay đổi
- [`src/adapters/ai-studio/ai-studio-dom-observer.ts`](../../src/adapters/ai-studio/ai-studio-dom-observer.ts):
  - Thêm `.author-label`, `ms-chat-loading-indicator`, `[class*='loading-indicator' i]`, `.actions-container` vào danh sách node nhiễu bị xóa khi clone `targetAnswer`.
  - Ở fast-path (`isGenerating && !captureFullWhileGenerating`), ưu tiên đo `textContent.length` bên trong các thẻ `ms-prompt-chunk` để không tính header + indicator `Thinking` thành `hasContent = true`.
  - Trong `applyStatus()`, giữ nguyên `state.lastObservedText` và `state.lastHtml` khi đi qua nhịp fast-path rỗng HTML xen giữa các chu kỳ `650ms`.
- [`src/assistant/assistant-stream-gate.ts`](../../src/assistant/assistant-stream-gate.ts):
  - Cập nhật `extractAlignedRemainingText(..., fallbackOnMismatch)` khi `finalizeAsFinalAnswer()` chạy: nếu clipboard thêm `**bold**` ngay đầu câu thì so khớp bỏ qua ký tự `*`, `_`, `` ` `` để nối đúng phần đuôi; nếu `emittedText` và đáp án cuối lệch hoàn toàn thì vẫn phát nối đáp án cuối thay vì trả chuỗi rỗng.
- Kiểm thử bổ sung tại [`tests/ai-studio-adapter.test.ts`](../../tests/ai-studio-adapter.test.ts) và [`tests/assistant-stream-gate.test.ts`](../../tests/assistant-stream-gate.test.ts).
