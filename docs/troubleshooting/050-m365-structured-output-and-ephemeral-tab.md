# 050 - Tối ưu prompt Structured Output (`json_schema`) và tự đóng tab phụ sinh tiêu đề

> **Trạng thái:** ⏳ Chờ User Test & Confirm
> **Providers:** `core`, `web`, `m365-copilot`, `launcher`, `electron`

## ⚡ TL;DR
- **Triệu chứng:** Khi bắt đầu cuộc trò chuyện mới trên Codex, yêu cầu phụ sinh tiêu đề (`text.format.type === "json_schema"`) bị gửi kèm toàn bộ bridge prompt ~10 KB (`<tool_call>`, `apply_patch`), thỉnh thoảng trả về YAML khiến Codex không cập nhật được tiêu đề, và tab phụ M365 bị giữ lại sau khi hoàn tất.
- **Nguyên nhân gốc rễ:** Tầng `src/adapters/web/` chưa xử lý `parsed.options.outputFormat` ở khâu biên dịch prompt/validate response, còn `releaseWebTurnSurface()` hardcode `retain: true` và `BrowserHost.endTurn()` luôn ép bind persistent URL cho M365 trước khi xét `retain`.
- **Cách sửa:** Bổ sung scenario `STRUCTURED_JSON_OUTPUT` gọn nhẹ, parser + JSON Schema validator + retry chuyên biệt (`INVALID_JSON_SCHEMA_OUTPUT`), cách ly `conversationKey` tạm + trả `retain: false` cho one-shot `json_schema`, và chỉ bind persistent / chờ `/chat/conversation/{id}` khi `retain === true`.

## Thay đổi chính
- [src/adapters/web/prompt/templates.ts](../../src/adapters/web/prompt/templates.ts), [conversation-scenario-builder.ts](../../src/adapters/web/prompt/conversation-scenario-builder.ts), [compiler.ts](../../src/adapters/web/prompt/compiler.ts): Thêm `STRUCTURED_JSON_OUTPUT`, `buildStructuredJsonOutputProtocol`, `buildJsonSchemaRetryPrompt`, và `isStructuredJsonOutputTurn`.
- [src/adapters/web/protocol/json-schema-response.ts](../../src/adapters/web/protocol/json-schema-response.ts), [strict-response-parser.ts](../../src/adapters/web/protocol/strict-response-parser.ts), [retry-response.ts](../../src/adapters/web/protocol/retry-response.ts): Thêm `parseAndValidateJsonSchemaResponse`, `validateValueAgainstJsonSchema`, mã lỗi `INVALID_JSON_SCHEMA_OUTPUT`, chuẩn hóa output JSON thuần 1 dòng.
- [src/adapters/web/definition.ts](../../src/adapters/web/definition.ts), [engine.ts](../../src/adapters/web/engine.ts), [runtime-lifecycle.ts](../../src/adapters/web/runtime-lifecycle.ts), [base-browser-worker.ts](../../src/adapters/web/browser/base-browser-worker.ts): Cho phép `resolveEndTurnBinding` quyết định `retain` động và truyền `retain` xuống worker + `/v1/turn/end`.
- [src/adapters/m365-copilot/index.ts](../../src/adapters/m365-copilot/index.ts), [m365-browser-worker.ts](../../src/adapters/m365-copilot/m365-browser-worker.ts): Cách ly ephemeral `conversationKey`, trả `retain: false` cho one-shot `json_schema`, và bỏ qua chờ `/chat/conversation/{id}` khi `retain === false`.
- [launcher/electron/browser-host.cjs](../../launcher/electron/browser-host.cjs): Chỉ chạy `m365SurfaceManager.bind(...)` khi `retain === true`, còn `retain === false` sẽ gọi `removeTurnTab(tab, false)` ngay để đóng tab phụ.
- [tests/web-structured-output.test.ts](../../tests/web-structured-output.test.ts), [launcher/tests/view-lifecycle-manager.test.cjs](../../launcher/tests/view-lifecycle-manager.test.cjs): Bổ sung test kiểm tra prompt gọn, schema validation + auto-retry, ephemeral M365 worker và `endTurn` tự đóng tab.

