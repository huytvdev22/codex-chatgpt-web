# 059 - Triển khai API tạo Voice Podcast tương thích Gemini TTS qua Google AI Studio UI

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày thực hiện:** 2026-11-16  
> **Phạm vi:** `src/adapters/ai-studio/`, `src/services/gemini-speech-service.ts`, `src/controllers/gemini-speech-controller.ts`, `src/server.ts`, `docs/swagger.html`

## ⚡ TL;DR
1. **Nhu cầu:** Cung cấp endpoint tương thích Gemini API (`POST /v1beta/models/gemini-2.5-pro-preview-tts:streamGenerateContent` & `:generateContent`) để client gọi không cần `GEMINI_API_KEY`, server điều khiển ngầm giao diện Google AI Studio `/generate-speech` qua Launcher.
2. **Giải pháp kỹ thuật:** Tạo `AiStudioSpeechWorker` điều khiển trang `/generate-speech` ở chế độ `Text` (tự tách `Scene`, `Sample Context`, `Transcript`, `Audio Profile`, `Director's note`), khớp từng speaker theo `speaker-alias-input` sau khi dán transcript để tránh lệch thứ tự `Speaker 1`/`Speaker 2`, và trích xuất audio `.wav` mới (bỏ qua audio mẫu mặc định).
3. **Đầu ra:** Trả về JSON chuẩn Gemini `candidates[0].content.parts[0].inlineData` (`mimeType: "audio/wav"`, `data: "<base64>"`), chạy qua tab Launcher tạm thời (`retain: false`) nhờ `WebTurnEngine.runEphemeralSurfaceTask()`.

## Thay đổi chính
- [ai-studio-speech-worker.ts](../../src/adapters/ai-studio/ai-studio-speech-worker.ts) & [index.ts](../../src/adapters/ai-studio/index.ts): `AiStudioSpeechWorker`, `parseGeminiSpeechScript`, `AiStudioAdapter.runSpeechTurn()`.
- [engine.ts](../../src/adapters/web/engine.ts) & [runtime-lifecycle.ts](../../src/adapters/web/runtime-lifecycle.ts): bổ sung `runEphemeralSurfaceTask()` và `retainOverride: false` để đóng tab tạm sau khi sinh audio xong.
- [gemini-speech-service.ts](../../src/services/gemini-speech-service.ts), [gemini-speech-controller.ts](../../src/controllers/gemini-speech-controller.ts), [server.ts](../../src/server.ts): mở route `POST /v1beta/models/:model:(generateContent|streamGenerateContent)` (hỗ trợ cả JSON array và `?alt=sse`).
- [swagger.html](../../docs/swagger.html) & [gemini-speech.test.ts](../../tests/gemini-speech.test.ts): cập nhật Swagger UI với ví dụ podcast mẫu và 4 unit/integration tests.

