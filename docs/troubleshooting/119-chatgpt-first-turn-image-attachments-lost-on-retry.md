# 119 — Bảo Toàn Ảnh Đính Kèm Turn 1 ChatGPT Qua Retry & Failover (BUG-02 Phase 2)

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Providers / Phạm vi:** `chatgpt`, `web`, `playwright`
- **Keywords:** `extractAttachments`, `insertPrompt`, `waitForUploadSettlement`, `WebTurnEngine`, `pre_submit`, `failover`, `post-submit format retry`

## ⚡ TL;DR
1. **Triệu chứng:** Ảnh đính kèm ở lượt đầu (`Turn 1`) trên ChatGPT Web bị mất hoặc gửi prompt rỗng ảnh khi xảy ra lỗi upload, retry transport/pre-submit, hoặc profile failover; đồng thời `waitForUploadSettlement` có thể im lặng bỏ qua timeout/lỗi evaluate.
2. **Nguyên nhân gốc rễ:** (a) `ChatGptBrowserWorker.insertPrompt` dùng `.catch(() => console.warn(...))` nuốt lỗi đính kèm ảnh và `ChatGptAttachments.waitForUploadSettlement` trả về thành công khi timeout/`!form`/`.catch(() => true)`; (b) `ChatGptAdapter.extractAttachments` chỉ kiểm tra `attempt !== 0` và `ChatGptAdapter.browser.executeTurn` ghi đè `isNewConversation` thành `false` khi `attempt > 0`, không phân biệt retry pre-submit/transport/failover với post-submit format retry.
3. **Cách sửa:**
   - Gỡ `.catch` nuốt lỗi trong [chatgpt-browser-worker.ts](../../src/adapters/chatgpt/chatgpt-browser-worker.ts) và siết [attachments.ts](../../src/adapters/chatgpt/attachments.ts) để fail-closed khi thiếu form, thấy error banner hoặc quá thời gian chờ upload settlement.
   - Mở rộng `WebAttachmentExtractContext` trong [definition.ts](../../src/adapters/web/definition.ts) và truyền ngữ cảnh phân biệt `initial` / `failover` / `format` / `tool_describe` / `tool_recovery` + `originalMessageSubmitted` từ [engine.ts](../../src/adapters/web/engine.ts).
   - Cập nhật `shouldIncludeChatGptAttachments` và giữ nguyên `isNewConversation` trong [index.ts](../../src/adapters/chatgpt/index.ts); bổ sung regression test trong [chatgpt-adapter.test.ts](../../tests/chatgpt-adapter.test.ts) và [chatgpt-browser-worker.test.ts](../../tests/chatgpt-browser-worker.test.ts) (chưa chạy lệnh shell kiểm chứng do ràng buộc phiên làm việc).
