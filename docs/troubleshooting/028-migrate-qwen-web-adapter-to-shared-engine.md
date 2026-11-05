# 028 — Chuyển `QwenWebAdapter` sang dùng `WebProviderAdapter` & `WebTurnEngine`

**Trạng thái:** `⏳ Chờ User Test & Confirm`

## ⚡ TL;DR
- **Triệu chứng:** `src/adapters/qwen-web/index.ts` tự triển khai vòng đời `runTurn()` thủ công (quản lý Launcher lease, biên dịch prompt, retry giao thức `<webResponse>`, emit response), trùng lặp với các Web provider khác.
- **Nguyên nhân gốc rễ:** `QwenWebAdapter` chưa được chuyển sang kế thừa `WebProviderAdapter` và ủy quyền điều phối cho `WebTurnEngine`.
- **Cách sửa:** Cho `QwenWebAdapter` kế thừa `WebProviderAdapter` với `WebProviderDefinition` cấu hình đặc thù của Qwen (`launcherFailureMode: "fail-closed"`, `emitErrorEventOnFailure: false`, `defaultQwenConversationStore`, `isValidQwenConversationId`) và bảo toàn `abortTurn()` / `cleanup()`.

## 1. Phạm vi thay đổi (Atomic Slice #7)
- **Cập nhật:**
  - `src/adapters/qwen-web/index.ts`: Kế thừa `WebProviderAdapter`, rút gọn từ 249 dòng xuống 161 dòng, bảo toàn đầy đủ API và hành vi runtime của Qwen Web.

## 2. Kết quả kiểm chứng
- `git diff --check`: Pass
- `bun run check:architecture`: Pass (`0 cycles`, directionality gate pass)
- `bun test tests/qwen-web-adapter.test.ts`: `8 pass, 0 fail`
- `bun test tests/web-turn-engine.test.ts`: `5 pass, 0 fail`
- `bun test tests/m365-*.test.ts`: `215 pass, 0 fail`
- `bun run build`: Pass
- `src/` TypeScript errors: `0`
