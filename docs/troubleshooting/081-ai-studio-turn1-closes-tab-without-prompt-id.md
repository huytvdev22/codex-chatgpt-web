# 081: Google AI Studio Turn 1 tắt tab khi chưa kịp có `/prompts/{id}` khiến Turn 2 mở cuộc trò chuyện mới

> **Trạng thái:** ✅ Đã Confirm  
> **Providers:** `ai-studio`, `web`, `launcher`  
> **Keywords:** `retain`, `connectorIdentity`, `activeConversationId`, `/prompts/new_chat`, `launcherReused`, `TurnTabManager`

## ⚡ TL;DR
1. **Triệu chứng:** Khi gửi tin nhắn đầu tiên (`"xin chào"`) sang Google AI Studio từ Codex, tab bị đóng ngay khi trả lời xong; tới tin nhắn thứ 2 (`"review nhanh code base cho tôi"`), Launcher phải mở tab và cuộc trò chuyện mới hoàn toàn (mất ngữ cảnh & tool catalog Turn 1).
2. **Nguyên nhân gốc rễ:** Khi Google AI Studio chưa kịp lưu Drive để chuyển URL sang `/prompts/{id}` trong 6 giây sau Turn 1, `AiStudioAdapter` đặt `resolveEndTurnBinding` trả `retain: false` (vì có `connectorIdentity: "ai-studio"` khiến `TurnTabManager` bắt buộc phải có `conversationId`), làm Launcher đóng ngay tab Turn 1. Ngoài ra, `AiStudioBrowserWorker.navigate()` trước đây còn ném lỗi hoặc gọi `page.goto(new_chat)` nếu tab tái sử dụng chưa có `existingConversationId`.
3. **Cách sửa:** Bỏ `connectorIdentity` cố định ở [src/adapters/ai-studio/index.ts](../../src/adapters/ai-studio/index.ts) (cho `WebBrowserDriver.connectorIdentity` optional ở [definition.ts](../../src/adapters/web/definition.ts)), để `resolveEndTurnBinding` luôn trả `retain: true` khi `finalStatus === "completed"` (trừ ephemeral `json_schema`) giúp `TurnTabManager` giữ tab sống theo `conversationKey` kể cả khi chưa có `/prompts/{id}` và vẫn bind vào disk ngay khi có `conversationId`; đồng thời cập nhật `navigate()` trong [ai-studio-browser-worker.ts](../../src/adapters/ai-studio/ai-studio-browser-worker.ts) giữ nguyên hội thoại trên tab tái sử dụng (`launcherReused && (currentConversationId || isNewConversation === false)`) và rút thời gian chờ `/prompts/{id}` về `3_000ms`.

## Thay đổi
- [src/adapters/web/definition.ts](../../src/adapters/web/definition.ts): Cho phép `WebBrowserDriver.connectorIdentity` là optional (`string | undefined`).
- [src/adapters/ai-studio/index.ts](../../src/adapters/ai-studio/index.ts): Gỡ `connectorIdentity: "ai-studio"`, giữ `retain: true` khi `finalStatus === "completed"` (không phải ephemeral `json_schema`) dù `!activeConversationId`, và chỉ set `connectorBound: Boolean(activeConversationId)`.
- [src/adapters/ai-studio/ai-studio-browser-worker.ts](../../src/adapters/ai-studio/ai-studio-browser-worker.ts): Giữ nguyên tab khi `launcherReused` và `isNewConversation === false` hoặc URL vừa tự lưu thành `/prompts/{id}`; giảm timeout `waitForAiStudioConversationId` xuống `3_000ms`.
- [tests/ai-studio-adapter.test.ts](../../tests/ai-studio-adapter.test.ts): Cập nhật unit test `resolveEndTurnBinding` và bổ sung test `navigate()` cho tab tái sử dụng chưa có `existingConversationId`.
