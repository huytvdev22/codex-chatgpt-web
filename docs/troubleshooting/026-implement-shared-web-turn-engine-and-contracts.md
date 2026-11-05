# 026 - Triển khai `WebTurnEngine`, `WebProviderAdapter` và Driver Contracts tại `src/adapters/web`

## ⚡ TL;DR
- **Triệu chứng:** Cả 5 Web Adapter tự lặp lại 150-300 dòng code điều phối `runTurn()` (lease trình duyệt, biên dịch prompt, retry giao thức, phát sự kiện SSE, giải phóng lượt).
- **Nguyên nhân gốc rễ:** Chưa có Orchestrator cấp cao (`WebTurnEngine`) và bộ hợp đồng Driver/Policy (`WebProviderDefinition`) trong `src/adapters/web/`.
- **Cách sửa:** Tạo `definition.ts`, `runtime-lifecycle.ts`, `engine.ts` (`WebTurnEngine`) và `web-provider-adapter.ts` (`WebProviderAdapter`) kèm bộ unit test hợp đồng `tests/web-turn-engine.test.ts`.

## Trạng thái

✅ Đã Confirm

## Phạm vi thay đổi (Atomic Slice #5)

- **Modules mới trong `src/adapters/web/`:**
  - `src/adapters/web/definition.ts`: Khai báo `WebProviderDefinition`, `WebConversationDriver`, `WebCapabilityPickerDriver`, `WebAttachmentDriver`, `WebBrowserDriver`, `WebResponseDriver`, `WebProviderPolicies`.
  - `src/adapters/web/runtime-lifecycle.ts`: Điều phối `acquireWebTurnSurface` và `releaseWebTurnSurface`.
  - `src/adapters/web/engine.ts`: `WebTurnEngine` hợp nhất toàn bộ pipeline thực thi lượt.
  - `src/adapters/web/web-provider-adapter.ts`: `WebProviderAdapter` triển khai `ProviderAdapter`.
- **Tests mới:**
  - `tests/web-turn-engine.test.ts`: Kiểm thử toàn diện các nhánh hợp đồng của `WebTurnEngine`.

## Xác minh

- `git diff --check`: Pass.
- `bun run check:architecture`: Pass (0 circular dependencies, 0 reverse imports).
- `bun test tests/web-turn-engine.test.ts`: 5 pass, 0 fail.
- `bun test tests/m365-*.test.ts`: 215 pass, 0 fail.
- Bộ test Web Adapters (7 files): 59 pass, 0 fail.
- `bun run build`: Pass.
- `bun run typecheck`: 0 lỗi trong `src/`.
