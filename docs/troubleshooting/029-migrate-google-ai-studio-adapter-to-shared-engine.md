# 029 — Chuyển `GoogleAIStudioAdapter` sang dùng `WebProviderAdapter` & `WebTurnEngine`

**Trạng thái:** `⏳ Chờ User Test & Confirm`

## ⚡ TL;DR
- **Triệu chứng:** `src/adapters/google-ai-studio/index.ts` tự viết tay toàn bộ vòng đời `runTurn()` (quản lý Launcher lease, biên dịch prompt, retry giao thức, emit response), trùng lặp với các Web provider khác.
- **Nguyên nhân gốc rễ:** `GoogleAIStudioAdapter` chưa được chuyển sang kế thừa `WebProviderAdapter` và ủy quyền điều phối cho `WebTurnEngine`.
- **Cách sửa:** Cho `GoogleAIStudioAdapter` kế thừa `WebProviderAdapter` với `WebProviderDefinition` cấu hình đặc thù của Google AI Studio (`sanitizeAIStudioResponse`, `tolerantNaturalTextFallback: true`, `classifyValidationFailure`, `includeDetailedDoneEvent: true`, `computeUsage`, `closeLauncherConnectionOnEnd: false`).

## 1. Phạm vi thay đổi (Atomic Slice #8)
- **Cập nhật:**
  - `src/adapters/google-ai-studio/index.ts`: Kế thừa `WebProviderAdapter`, rút gọn từ 312 dòng xuống 210 dòng, giữ nguyên `sanitizeAIStudioResponse` và mọi hành vi đặc thù của Google AI Studio.

## 2. Kết quả kiểm chứng
- `git diff --check`: Pass
- `bun run check:architecture`: Pass (`0 cycles`, directionality gate pass)
- `bun test tests/google-ai-studio.test.ts`: `12 pass, 0 fail`
- `bun test tests/web-turn-engine.test.ts`: `5 pass, 0 fail`
- `bun test tests/m365-*.test.ts`: `215 pass, 0 fail`
- `bun run build`: Pass
- `src/` TypeScript errors: `0`
