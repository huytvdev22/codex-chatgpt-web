# 031 — Chuyển `M365CopilotAdapter` sang dùng `WebProviderAdapter` & `WebTurnEngine`

**Trạng thái:** `✅ Đã Confirm`

## ⚡ TL;DR
- **Triệu chứng:** `src/adapters/m365-copilot/index.ts` tự viết tay toàn bộ vòng lặp điều phối `runTurn()` (early-exit check, compile prompt, retry giao thức, loop guard, emit tool/final answer), tách biệt với 4 Web provider còn lại.
- **Nguyên nhân gốc rễ:** `M365CopilotAdapter` chưa được chuyển sang kế thừa `WebProviderAdapter` và ủy quyền điều phối cho `WebTurnEngine`.
- **Cách sửa:** Cho `M365CopilotAdapter` kế thừa `WebProviderAdapter` với `WebProviderDefinition` cấu hình đặc thù của M365 (`manageLauncherLeaseInEngine: false`, `enableEarlyExitOnFinalAnswer: true`, `enableToolLoopGuard: true`, `attachments.extractAttachments`, `executeM365Turn`), giữ nguyên 100% hành vi runtime và toàn bộ Root Facade exports.

## 1. Phạm vi thay đổi (Atomic Slice #10)
- **Cập nhật:**
  - `src/adapters/m365-copilot/index.ts`: Kế thừa `WebProviderAdapter`, rút gọn từ 333 dòng xuống 133 dòng, bảo toàn toàn bộ Root Facade re-exports.
  - `src/adapters/web/protocol/emit-response.ts`, `src/adapters/web/definition.ts`, `src/adapters/web/engine.ts`: Hỗ trợ `toolCallStopReason: "tool_use"`, `toolCallEndTurn: false`, `abortedTurnMessage` và `maxFormatRetries` động theo biến môi trường `M365_FORMAT_MAX_RETRIES`.

## 2. Kết quả kiểm chứng
- `git diff --check`: Pass
- `bun run check:architecture`: Pass (`0 cycles`, directionality gate pass, Root Facade exports pass)
- `bun test tests/m365-*.test.ts`: `215 pass, 0 fail`
- `bun test tests/web-turn-engine.test.ts tests/gemini-web-adapter.test.ts tests/qwen-web-adapter.test.ts tests/google-ai-studio.test.ts tests/chatgpt-web-adapter.test.ts tests/chatgpt-conversation-store.test.ts tests/chatgpt-web-markdown.test.ts tests/chatgpt-web-models.test.ts`: `64 pass, 0 fail`
- `bun run build`: Pass
- `src/` TypeScript errors: `0`
