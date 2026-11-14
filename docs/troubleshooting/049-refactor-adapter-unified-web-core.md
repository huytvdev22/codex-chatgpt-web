# 049: Hợp nhất Unified Web Core và tách mỏng Web Transport Adapter (`src/adapters/web` + `m365-copilot`)

**Trạng thái:** ⏳ Chờ User Test & Confirm  
**Ngày thực hiện:** 2026-11-14  
**Nhánh:** `refactor/adapter-unified-web-core`  
**Phạm vi:** `src/adapters/web/**`, `src/adapters/m365-copilot/**`, `src/responses/turn-identity.ts`, `src/services/responses-service.ts`

---

## ⚡ TL;DR
1. **Triệu chứng:** Logic dùng chung ở `src/adapters/web/` vẫn còn trộn tham số M365 (`Microsoft 365 Copilot`, `m365-copilot/think`, `m365HtmlToMarkdown`), `M365BrowserWorker` tự override `waitForCompletion()` (~415 dòng) bỏ qua heartbeat dùng chung, còn `harness/` + `prompt/assembler.ts` + `conversation-store.ts` tồn tại song song gây phân mảnh khi mở rộng adapter mới (ChatGPT Web, v.v.).
2. **Nguyên nhân gốc rễ:** Lớp dùng chung chưa tham số hóa hoàn toàn theo `WebProviderDefinition`, DOM observation/salvage còn gắn chặt trong `M365BrowserWorker`, và code legacy từ giai đoạn tiền `WebTurnEngine` chưa được dọn bỏ.
3. **Cách sửa:** Tham số hóa `WebPromptCompiler` / `CodexPayloadNormalizer` / `SemanticMarkdownBuffer` theo `WebProviderDefinition`; tách `M365DomObserver` và `M365ClipboardSalvage` để `M365BrowserWorker` dùng chung `BaseWebBrowserWorker.waitForCompletion()`; tách `WebTurnLoopGuard` và `src/responses/turn-identity.ts`; gỡ bỏ `prompt/assembler.ts`, `harness/`, `conversation-store.ts`.

---

## Tóm tắt 4 Phase & Commits
- **Phase 1 (`d9d759c`):** Tổng quát hóa `WebPromptCompiler`, `CodexPayloadNormalizer`, `SemanticMarkdownBuffer`, bỏ `compilePrompt` override trùng lặp ở `M365CopilotAdapter`.
- **Phase 2 (`f974046`):** Tách `M365DomObserver` và `M365ClipboardSalvage`; gỡ `waitForCompletion()` override khỏi `M365BrowserWorker` để chạy chung polling + heartbeat qua `BaseWebBrowserWorker`.
- **Phase 3 (`7b81162`):** Tách `WebTurnLoopGuard`, chuyển pure parser turn-identity sang `src/responses/turn-identity.ts`, trung tính hóa tên hàm/log tại `src/adapters/web/`.
- **Phase 4 (`82036c9`):** Xóa `prompt/assembler.ts`, `harness/`, `conversation-store.ts`, chuyển toàn bộ test sang `compileWebPrompt` & `WebTurnLoopGuard`.
- **Dọn dẹp hậu kiểm:** Trung tính hóa `WebOutputTranslator` (`[WEB RAW RESPONSE]`), `WebToolCallDetector`, `WebMarkdownBuffer`, `src/adapters/web/tools/` (`normalizeWebToolArguments`, `decodeWebContent`, `validateWebToolCall`) kèm `@deprecated` alias tương thích ngược; đồng bộ `docs/system-architecture.md` và `docs/adding-new-web-adapter-guide.md`.
