# 086 - Triển khai Personalization & Workspace Memory 2 tầng (`/v1/responses` + Electron Launcher)

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày thực hiện:** 2026-11-20  
> **Nhánh:** `feat/personalization`  
> **Phạm vi:** `src/personalization/`, `src/adapters/web/`, `launcher/electron/`, `launcher/src/`

## ⚡ TL;DR
1. **Nhu cầu:** Bổ sung tính năng Personalization (Profile, Tone, Custom Instructions, Saved Memories) và cơ chế Workspace Memory (`<cwd>/.codex-copilot/MEMORY.md`) cho Codex (`/v1/responses`), quản lý trực tiếp từ Electron Launcher.
2. **Giải pháp:** Lưu Global Personalization tại `<configDir>/personalization.json` (hot-reload theo `mtimeMs` + `size` ở `PersonalizationStore`, đồng bộ giữa Launcher và `server.ts`); `WebTurnEngine` + `WebPromptSessionStore` + `WebPromptCompiler` chèn Global section ở Turn 1 (hoặc chèn lại 1 lần khi sửa giữa phiên) và gợi ý `<cwd>/.codex-copilot/` (chỉ check `existsSync` + tên file `.md`) ở Turn 1 + `PURE_CONVERSATION`, bỏ qua `STRUCTURED_JSON_OUTPUT`, `TOOL_RESULT` lặp lại và `/v2/responses`.
3. **Giao diện:** Thêm tab riêng `Personalization` trên Sidebar trái Launcher (`PersonalizationSurface.tsx`), IPC `launcher:personalization-get`/`save`, i18n đủ 5 ngôn ngữ và khung Preview live.

## Thay đổi chính
- **Domain & Prompt (`src/personalization/`):** [types.ts](../../src/personalization/types.ts), [personalization-store.ts](../../src/personalization/personalization-store.ts), [personalization-prompt-builder.ts](../../src/personalization/personalization-prompt-builder.ts), [index.ts](../../src/personalization/index.ts).
- **Web Core Integration (`src/adapters/web/`):** [canonical-types.ts](../../src/adapters/web/normalization/canonical-types.ts), [codex-normalizer.ts](../../src/adapters/web/normalization/codex-normalizer.ts), [web-prompt-session-store.ts](../../src/adapters/web/execution/web-prompt-session-store.ts), [conversation-scenario-builder.ts](../../src/adapters/web/prompt/conversation-scenario-builder.ts), [compiler.ts](../../src/adapters/web/prompt/compiler.ts), [compile-prompt.ts](../../src/adapters/web/compile-prompt.ts), [engine.ts](../../src/adapters/web/engine.ts).
- **Electron Launcher (`launcher/`):** [personalization-store.cjs](../../launcher/electron/infra/personalization-store.cjs), [main.cjs](../../launcher/electron/main.cjs), [ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs), [preload.cjs](../../launcher/electron/preload.cjs), [PersonalizationSurface.tsx](../../launcher/src/components/PersonalizationSurface.tsx), [personalization-preview.ts](../../launcher/src/personalization-preview.ts), [App.tsx](../../launcher/src/App.tsx), [i18n.ts](../../launcher/src/i18n.ts), [types.ts](../../launcher/src/types.ts), [icons.tsx](../../launcher/src/icons.tsx), [styles.css](../../launcher/src/styles.css).
- **Kiểm thử:** [tests/personalization.test.ts](../../tests/personalization.test.ts), [launcher/tests/personalization.test.cjs](../../launcher/tests/personalization.test.cjs), [launcher/tests/renderer-wiring.test.cjs](../../launcher/tests/renderer-wiring.test.cjs).
