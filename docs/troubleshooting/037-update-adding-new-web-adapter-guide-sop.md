# 037: Cập nhật tài liệu SOP `docs/adding-new-web-adapter-guide.md` theo kiến trúc `WebTurnEngine`

## ⚡ TL;DR
- **Triệu chứng:** `docs/adding-new-web-adapter-guide.md` (cập nhật lần cuối ở commit `fac65c5`) vẫn hướng dẫn tự viết `compilePrompt`, tự gọi `parseStrictM365Response`/`M365ToolBridge` trong `index.ts` và trỏ tới đường dẫn cũ `src/model-catalog.ts`.
- **Nguyên nhân gốc rễ:** Sau chuỗi refactor `WebTurnEngine` (`022`–`036`), toàn bộ điều phối prompt, protocol, retry, lifecycle và tool bridge đã chuyển về `WebProviderAdapter` -> `WebTurnEngine`, khiến SOP cũ có nguy cơ dẫn developer viết lại logic điều phối trái kiến trúc mới.
- **Cách sửa:** Viết lại toàn bộ `docs/adding-new-web-adapter-guide.md` theo chuẩn mới (`WebProviderAdapter`, `WebTurnEngine`, `WebProviderDefinition`, `GenericConversationStore`, bảng quyết định `WebProviderPolicies`, API trung lập `Web*`, đường dẫn `src/models/*` và checklist cổng kiến trúc `bun run check:architecture`).

## Phạm vi thay đổi
- `docs/adding-new-web-adapter-guide.md`:
  - Cập nhật luồng chuẩn: khảo sát DOM -> viết `browser-worker.ts` & `capability-picker.ts` -> dùng `GenericConversationStore` -> khai báo `WebProviderDefinition` & `WebProviderPolicies` -> kế thừa `WebProviderAdapter`.
  - Bổ sung bảng quyết định Lifecycle & Error Policies (`launcherFailureMode`, `manageLauncherLeaseInEngine`, `closeLauncherConnectionOnEnd`, `emitErrorEventOnFailure`, `rethrowError`, `maxFormatRetries`, `enableEarlyExitOnFinalAnswer`, `enableToolLoopGuard`).
  - Thay thế hoàn toàn các tên compatibility cũ (`parseStrictM365Response`, `M365ToolBridge`) bằng API trung lập chuẩn (`parseStrictWebResponse`, `WebToolBridge`, `WebProtocolErrorCode`, `StrictWebResponseResult`).
  - Cập nhật đường dẫn đăng ký model sang `src/models/model-registry.ts` và `src/models/model-catalog.ts`.
  - Bổ sung checklist kiểm thử kiến trúc (`bun run check:architecture`, `tests/web-turn-engine.test.ts`, `tests/m365-architecture-integrity.test.ts`).

## Kết quả xác minh
- `git diff --check`: Pass.
- `bun run check:architecture`: Pass (`4 pass, 0 fail`).

## Trạng thái
⏳ Chờ User Test & Confirm
