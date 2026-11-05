# 030 — Chuyển `ChatGptWebAdapter` sang dùng `WebProviderAdapter` & `WebTurnEngine`

**Trạng thái:** `✅ Đã Confirm`

## ⚡ TL;DR
- **Triệu chứng:** `src/adapters/chatgpt-web/index.ts` tự triển khai toàn bộ vòng đời `runTurn()` thủ công (quản lý Launcher lease, biên dịch prompt, retry giao thức `<webResponse>`, emit response), trùng lặp với các Web provider khác.
- **Nguyên nhân gốc rễ:** `ChatGptWebAdapter` chưa được chuyển sang kế thừa `WebProviderAdapter` và ủy quyền điều phối cho `WebTurnEngine`.
- **Cách sửa:** Cho `ChatGptWebAdapter` kế thừa `WebProviderAdapter` với `WebProviderDefinition` cấu hình đặc thù của ChatGPT Web (`defaultChatGptConversationStore`, `isValidChatGptConversationId`, `compilePrompt` facade) và bảo toàn mọi re-export công khai.

## 1. Phạm vi thay đổi (Atomic Slice #9)
- **Cập nhật:**
  - `src/adapters/chatgpt-web/index.ts`: Kế thừa `WebProviderAdapter`, rút gọn từ 258 dòng xuống 168 dòng, bảo toàn method `compilePrompt` và toàn bộ re-export.

## 2. Kết quả kiểm chứng
- `git diff --check`: Pass
- `bun run check:architecture`: Pass (`0 cycles`, directionality gate pass)
- `bun test tests/chatgpt-web-adapter.test.ts tests/chatgpt-conversation-store.test.ts tests/chatgpt-web-markdown.test.ts tests/chatgpt-web-models.test.ts`: `26 pass, 0 fail`
- `bun test tests/web-turn-engine.test.ts`: `5 pass, 0 fail`
- `bun test tests/m365-*.test.ts`: `215 pass, 0 fail`
- `bun run build`: Pass
- `src/` TypeScript errors: `0`
