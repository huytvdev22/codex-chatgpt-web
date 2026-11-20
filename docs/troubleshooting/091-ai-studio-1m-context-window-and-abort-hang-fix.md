# 091 — Cấu hình AI Studio 1M Token, Khớp Context Window Codex & Fix Treo Abort/Network Khi Tab Ẩn

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Phạm vi:** `ai-studio`, `model-catalog`, `codex-usage`, `web-turn-engine`
- **Ngày:** 2026-11-20

## ⚡ TL;DR
- **Triệu chứng:** (1) Codex hiển thị context window AI Studio giới hạn `90k` và báo mức sử dụng thấp hơn thực tế (`3k` so với `24,832` trên AI Studio); (2) Khi ẩn Launcher và bật tab `Setup`, lượt chạy gửi được prompt sang AI Studio và AI gen xong nhưng Codex vẫn đứng `Thinking` tới lúc `upstream_stall_timeout` (300s) rồi mất thêm `60s` mới release tab.
- **Nguyên nhân gốc rễ:** (1) `AiStudioModelProvider` để `contextWindow: 100_000` (nên 90% = `90k`), `BaseModelProvider.isCatalogSynced` chưa kiểm tra `context_window`/`auto_compact_token_limit`, và `WebTurnEngine` gửi delta turn thay vì `sessionContextTokens` cho Codex `response.completed`; (2) Một request `GenerateContent` bị giữ `networkInFlight = true` ngăn hoàn tất/idle timeout khi DOM đã xong (`turn-footer`), và `stopGeneration()` gọi `innerText()`/`getAttribute()` không truyền `timeout` (mặc định 30s x 2 = 60s khi nút Stop không còn).
- **Cách sửa:** Nâng AI Studio lên `contextWindow: 1_000_000`, `autoCompactTokenLimit: 900_000`, `maxPromptChars: 350_000` và siết `isCatalogSynced()` tự rebuild catalog; gửi `codexWindowUsage` (dựa trên `sessionContextTokens`) về Codex trong khi giữ delta cho `UsageHistoryStore` & Footer; cho phép `AiStudioDomObserver` chốt hoàn tất qua `staleNetworkSettled` sau 20 nhịp ổn định có `turn-footer`, và thêm timeout ngắn (`600ms`–`2s`) cho `stopGeneration` / `waitForComposerIdle` / `scrollIntoViewIfNeeded`.

## Chi tiết thay đổi
- `src/adapters/ai-studio/model-provider.ts` & `src/adapters/ai-studio/index.ts`: Nâng `contextWindow = 1_000_000`, `autoCompactTokenLimit = 900_000`, `effectiveContextWindowPercent = 90`, `maxPromptChars = 350_000`.
- `src/models/base-model-provider.ts`: Mở rộng `isCatalogSynced()` so khớp thêm `context_window`, `max_context_window`, `effective_context_window_percent`, `auto_compact_token_limit`.
- `src/adapters/web/engine.ts`: Truyền `codexWindowUsage` (`sessionContextTokens` thực tế của phiên) vào `emitWebProtocolResponse` & `loopGuard.evaluate` để thanh `Context window` của Codex hiển thị chuẩn xác (khớp `ms-token-count` AI Studio).
- `src/adapters/ai-studio/ai-studio-dom-observer.ts`: Bổ sung `staleNetworkSettled` cho `applyStatus()` thoát trạng thái treo `networkInFlight` khi UI đã `!isGenerating` và có `.turn-footer` ổn định 20 nhịp.
- `src/adapters/ai-studio/ai-studio-browser-worker.ts`: Chặn treo 60s ở `stopGeneration()` (kiểm tra `count()` trước + `timeout: 600` + `textContent`), thêm `timeout: 600` ở `waitForComposerIdle()` và `timeout: 2_000` ở `targetTurn.scrollIntoViewIfNeeded()`; khi retry lỗi `permission denied` mà chưa có `liveConversationId` thì điều hướng về `new_chat?model=...` sạch thay vì reload lỗi dở dang.
- `launcher/electron/browser/providers/ai-studio/ai-studio-turn-surface.cjs` & `launcher/electron/browser/providers/m365/m365-turn-surface.cjs`: Reset `tab.deviceEmulationDirty = true` ở `did-start-navigation` (khi `!inPlace`) để sau `page.reload()`/`page.goto()` trên tab ẩn vẫn bật lại `enableHiddenTurnViewport`, tránh ô nhập bị ẩn (`hidden`) sau reload.
- `tests/ai-studio-adapter.test.ts`, `tests/model-catalog.test.ts`, `tests/web-turn-engine.test.ts`: Bổ sung unit test cho catalog 1M, context window usage, `staleNetworkSettled` và `stopGeneration`.
