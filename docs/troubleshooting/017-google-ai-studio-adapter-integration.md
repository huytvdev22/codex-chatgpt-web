# [ISSUE-017] Triển Khai Adapter Mới Google AI Studio Kế Thừa Chuẩn M365 Copilot

> **Status:** ⏳ Chờ User Test & Confirm  
> **Providers:** `google-ai-studio`, `launcher`, `electron`  
> **Keywords:** `google-ai-studio`, `aistudio.google.com`, `gemini-flash-latest`, `thinking-level`, `smoke-test`

## ⚡ TL;DR (AI Đọc Nhanh 5 Giây)
- **Triệu chứng:** Khi click nút "Sign in" hoặc chuyển provider sang `google-ai-studio`, app báo lỗi `Error invoking remote method 'launcher:set-provider': Error: Invalid provider`.
- **Nguyên nhân:** Whitelist provider trong handler IPC `launcher:set-provider` tại `launcher/electron/main.cjs` chỉ kiểm tra `m365`, `chatgpt`, `gemini`, `qwen`, thiếu `google-ai-studio`.
- **Cách sửa:** Thêm `&& provider !== "google-ai-studio"` vào handler `launcher:set-provider` trong `launcher/electron/main.cjs`.

## 🛠️ File Đã Triển Khai & Cập Nhật
1. **Core Models & Selectors:**
   - `src/google-ai-studio-models.ts`: Model slug `google-ai-studio`, model `gemini-flash-latest`, context window 1M tokens.
   - `src/adapters/google-ai-studio/selectors.ts`: Selectors textarea, nút Run, Stop, ms-chat-turn, Thinking Level dropdown.
   - `src/adapters/google-ai-studio/capability-picker.ts`: Automation chọn Thinking Level (`Low`, `Medium`, `High`).
   - `src/adapters/google-ai-studio/conversation-store.ts`: Lưu trữ mapping threadId <-> promptId để tiếp tục hội thoại cũ.
   - `src/adapters/google-ai-studio/browser-worker.ts`: Playwright worker dán prompt qua OS Clipboard (`Ctrl+v`), bấm Run, stream phản hồi (đã lọc `ms-thought-chunk`).
   - `src/adapters/google-ai-studio/index.ts`: Triển khai `GoogleAIStudioAdapter` chuẩn M365 protocol.
2. **Server & Catalog:**
   - `src/model-catalog.ts`: Đăng ký `google-ai-studio` vào catalog model của Codex.
   - `src/server.ts`: Thêm dispatch handler trong `/v1/responses` và compaction.
   - `src/launcher-browser-host.ts`: Cấu hình partition `persist:codex-google-ai-studio`.
3. **Launcher Electron & UI:**
   - `launcher/electron/google-ai-studio-surface-manager.cjs`: Quản lý surface và threadId <-> promptId.
   - `launcher/electron/google-ai-studio-turn-surface.cjs`: Turn hook & navigation binding.
   - `launcher/electron/browser-host.cjs`: Hỗ trợ switch provider, probe auth, run smoke test.
   - `launcher/electron/control-server.cjs`: Cho phép provider `"google-ai-studio"` trong begin/end turn.
   - `launcher/electron/state.cjs` & `main.cjs`: Lưu trữ state `googleAIStudioSmokePassed`.
   - `launcher/src/types.ts`: Mở rộng type union provider `"google-ai-studio"`.
   - `launcher/src/App.tsx`: Thêm UI Sign-in và Smoke Test trong trang Setup, thêm tab chọn trong Settings.

