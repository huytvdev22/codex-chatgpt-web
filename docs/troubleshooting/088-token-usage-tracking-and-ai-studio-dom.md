# 088 - Theo dõi Token Usage (AI Studio DOM `ms-token-count` + `tiktoken`, Tab `Usage` & Chat Footer)

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày thực hiện:** 2026-11-20  
> **Phạm vi:** `src/usage/`, `src/adapters/`, `launcher/electron/`, `launcher/src/`

## ⚡ TL;DR
1. **Vấn đề:** `m365-copilot` và `ai-studio` ước lượng token thô bằng `chars / 4`, không đọc bộ đếm `<ms-token-count>` của AI Studio DOM, và người dùng không thấy thống kê token trên Codex VS Code Extension hay Launcher.
2. **Giải pháp:** `AiStudioBrowserWorker` đọc `ms-token-count .v3-token-count-value` trước/sau turn để lấy `contextTokens` thật và `turnDeltaTokens`, kết hợp `tiktoken` (`o200k_base`) qua `computeAccurateTurnUsage()`; ghi lịch sử vào `usage-history.jsonl`, cộng dồn multi-step task qua `WebPromptSessionStore`, gắn footer tùy chọn vào `final_answer` (và tự strip khỏi `priorHistory`).
3. **Giao diện:** Thêm tab `Usage` trên Sidebar Electron Launcher (`UsageSurface.tsx`) hỗ trợ lọc `Today / 7d / 30d / All`, gom theo Provider/Model, xem nguồn đo (`AI Studio DOM` vs `tiktoken`) và bật/tắt chat footer.

## Thay đổi chính
- **Domain Usage (`src/usage/`):** [types.ts](../../src/usage/types.ts), [totals.ts](../../src/usage/totals.ts), [usage-settings-store.ts](../../src/usage/usage-settings-store.ts), [usage-history-store.ts](../../src/usage/usage-history-store.ts), [usage-footer-formatter.ts](../../src/usage/usage-footer-formatter.ts), [index.ts](../../src/usage/index.ts).
- **Adapter & Engine (`src/adapters/`):** [ai-studio-browser-worker.ts](../../src/adapters/ai-studio/ai-studio-browser-worker.ts), [ai-studio/index.ts](../../src/adapters/ai-studio/index.ts), [m365-copilot/index.ts](../../src/adapters/m365-copilot/index.ts), [base-browser-worker.ts](../../src/adapters/web/browser/base-browser-worker.ts), [definition.ts](../../src/adapters/web/definition.ts), [web-prompt-session-store.ts](../../src/adapters/web/execution/web-prompt-session-store.ts), [codex-normalizer.ts](../../src/adapters/web/normalization/codex-normalizer.ts), [engine.ts](../../src/adapters/web/engine.ts).
- **Electron Launcher (`launcher/`):** [usage-store.cjs](../../launcher/electron/infra/usage-store.cjs), [main.cjs](../../launcher/electron/main.cjs), [ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs), [preload.cjs](../../launcher/electron/preload.cjs), [UsageSurface.tsx](../../launcher/src/components/UsageSurface.tsx), [App.tsx](../../launcher/src/App.tsx), [types.ts](../../launcher/src/types.ts), [i18n.ts](../../launcher/src/i18n.ts), [styles.css](../../launcher/src/styles.css).
- **Kiểm thử:** [tests/usage-tracking.test.ts](../../tests/usage-tracking.test.ts), [launcher/tests/usage.test.cjs](../../launcher/tests/usage.test.cjs).

