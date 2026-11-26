# 106 — Giữ nguyên cuộc trò chuyện khi đổi Model cùng Provider & Chặn đổi khác Provider

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Providers / Phạm vi:** `gemini`, `chatgpt`, `ai-studio`, `m365-copilot`, `web`, `server`, `codex`

## ⚡ TL;DR
1. **Triệu chứng:** Khi đổi model (hoặc đổi mức `reasoning`) giữa chừng trong một thread Codex, hệ thống tạo tab và cuộc trò chuyện web hoàn toàn mới thay vì tiếp tục trên URL chat hiện tại; đồng thời chưa có cơ chế chặn/cảnh báo nếu người dùng đổi nhầm sang model của provider khác.
2. **Nguyên nhân gốc rễ:** `buildWebConversationKey` của các adapter hash cả `modelId` và `reasoning`, khiến Launcher coi đó là cuộc trò chuyện khác; `resolveState` lại tắt `isNewConversation` khi `hasPriorAssistantReply=true` dù chưa có `existingConversationId`; `AiStudioBrowserWorker` chưa có `CapabilityPicker` đổi model trên `/prompts/{id}`; các `CapabilityPicker` còn swallow lỗi fail-open khi không đổi được model; và `ResponsesService` chỉ nhớ `threadId -> providerId` tạm thời trong RAM.
3. **Cách sửa:**
   - Chuẩn hóa `conversationKey` chỉ hash theo `(provider, source)` ở cả 4 adapter (`gemini`, `chatgpt`, `ai-studio`, `m365-copilot`) để đổi model/reasoning cùng provider luôn giữ nguyên tab & URL chat web; sửa `resolveState` dùng `!launcherReused && !existingConversationId`.
   - Thêm `ThreadProviderBindingStore` (`src/services/thread-provider-binding-store.ts`, lưu LRU 512 thread ra `<configDir>/thread-provider-bindings.json`), chỉ khóa `threadId -> providerId` sau khi turn hoàn thành `status === "completed"`, và chặn cứng HTTP `400` (`invalid_request_error`) tại `ResponsesService` nếu đổi sang khác provider (kèm gợi ý model hợp lệ cùng provider).
   - Bổ sung `AiStudioCapabilityPicker` (`src/adapters/ai-studio/capability-picker.ts`) và nâng cấp `CapabilityPicker` cả 4 adapter sang **fail-closed** khi đổi model thất bại (giữ best-effort cho `reasoning`).

## Ghi chú kỹ thuật
- **File chính:**
  - `src/adapters/web/conversation/conversation-key.ts` & 4 file `src/adapters/*/conversation-key.ts`
  - `src/adapters/{gemini,chatgpt,ai-studio,m365-copilot}/index.ts` (`resolveState`)
  - `src/services/thread-provider-binding-store.ts`, `src/services/responses-service.ts`
  - `src/adapters/{gemini,chatgpt,ai-studio,m365-copilot}/capability-picker.ts` & `*-browser-worker.ts`
- **Kiểm thử:** `tests/thread-provider-switch-guard.test.ts` + cập nhật `tests/gemini-adapter.test.ts`, `tests/chatgpt-adapter.test.ts`, `tests/ai-studio-adapter.test.ts`, `tests/m365-conversation.test.ts`.
