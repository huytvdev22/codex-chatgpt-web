# 057 - Triển khai `POST /v2/responses` (Raw Passthrough & Target Conversation Persistence)

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày thực hiện:** 2026-11-16  
> **Phạm vi:** `src/adapters/`, `src/services/`, `src/controllers/`, `src/server.ts`, `docs/swagger.html`

## ⚡ TL;DR
1. **Nhu cầu:** Bổ sung API `POST /v2/responses` gửi nguyên văn `prompt` tới Web UI (không qua prompt builder hay strict response parser), chỉ trả JSON non-stream và bám đúng 1 target conversation.
2. **Giải pháp kiến trúc:** Thêm `WebTurnEngine.runRawTurn()` tái sử dụng hạ tầng lease/surface/abort của Launcher nhưng bỏ qua `compileWebPrompt` & `runWebProtocolRetry`; thêm `RawResponsesService` + `V2ConversationStore` lưu map `conversation_key <-> conversation_id` trên đĩa và khóa đồng thời `409 Conflict`.
3. **Sửa lỗi kèm theo:** Bổ sung `M365BrowserWorker.navigate()` tự điều hướng tới URL cuộc hội thoại cũ khi `!launcherReused` (tab mới sau restart/eviction) thay vì fail mismatch như trước.

## Thay đổi chính
- [base.ts](../../src/adapters/base.ts), [engine.ts](../../src/adapters/web/engine.ts), [web-provider-adapter.ts](../../src/adapters/web/web-provider-adapter.ts): thêm `RawTurnRequest` / `RawTurnResult` và `runRawTurn()`.
- [conversation-url.ts](../../src/adapters/m365-copilot/conversation-url.ts), [m365-browser-worker.ts](../../src/adapters/m365-copilot/m365-browser-worker.ts), [index.ts](../../src/adapters/m365-copilot/index.ts): thêm `normalizeM365ConversationId`, `buildM365ConversationUrl` và hỗ trợ mở lại conversation cũ khi `!launcherReused`.
- [v2-conversation-store.ts](../../src/services/v2-conversation-store.ts) & [raw-responses-service.ts](../../src/services/raw-responses-service.ts): validate payload (`stream: true` → `400`), lưu map `provider:conversationKey -> conversationId` tại `${getConfigDir()}/v2-conversations.json`, trả `409 Conflict` khi bắn song song cùng target conversation.
- [responses-controller.ts](../../src/controllers/responses-controller.ts), [server.ts](../../src/server.ts), [swagger.html](../../docs/swagger.html): mở route `POST /v2/responses` và cập nhật Swagger UI ghi chú rõ luồng Turn 1 vs Turn 2+.
- [v2-responses.test.ts](../../tests/v2-responses.test.ts): 6 test cases kiểm tra raw passthrough, persistence qua restart, lock `409`, `images`, `M365BrowserWorker.navigate()`, và HTTP routing.
