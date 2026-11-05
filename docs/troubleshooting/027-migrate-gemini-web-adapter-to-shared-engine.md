# 027 — Chuyển `GeminiWebAdapter` sang dùng `WebProviderAdapter` & `WebTurnEngine`

**Trạng thái:** `⏳ Chờ User Test & Confirm`

## ⚡ TL;DR
- **Triệu chứng:** `src/adapters/gemini-web/index.ts` tự viết tay toàn bộ vòng đời `runTurn()` (tạo traceId, kết nối Launcher / fallback LocalBrowser, biên dịch prompt, retry giao thức `<webResponse>`, emit response, giải phóng lease), trùng lặp với các Web provider khác.
- **Nguyên nhân gốc rễ:** `GeminiWebAdapter` chưa được chuyển sang kế thừa `WebProviderAdapter` và ủy quyền điều phối cho `WebTurnEngine`.
- **Cách sửa:** Cho `GeminiWebAdapter` kế thừa `WebProviderAdapter` với `WebProviderDefinition` khai báo các đặc thù riêng của Gemini (`launcherFailureMode: "fallback-local"`, `resolveGeminiReasoningEffort`, `geminiBrowserWorker.executeTurn`), giữ nguyên 100% hành vi runtime và API công khai.

## 1. Phạm vi thay đổi (Atomic Slice #6)
- **Cập nhật:**
  - `src/adapters/gemini-web/index.ts`: Kế thừa `WebProviderAdapter`, rút gọn từ 227 dòng xuống 111 dòng, chỉ giữ lại cấu hình đặc thù của Gemini.

## 2. Kết quả kiểm chứng
- `git diff --check`: Pass
- `bun run check:architecture`: Pass (`0 cycles`, directionality gate pass)
- `bun test tests/gemini-web-adapter.test.ts`: `9 pass, 0 fail`
- `bun test tests/web-turn-engine.test.ts`: `5 pass, 0 fail`
- `bun test tests/m365-*.test.ts`: `215 pass, 0 fail`
- `bun run build`: Pass
- `src/` TypeScript errors: `0`
