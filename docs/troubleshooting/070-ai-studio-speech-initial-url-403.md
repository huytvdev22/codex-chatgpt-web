# Lỗi 070: API `generateSpeech` (`streamGenerateContent`) thỉnh thoảng bị `403` từ Google AI Studio

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Providers:** `ai-studio`, `speech`, `launcher`, `playwright`  
> **Keywords:** `generateSpeech`, `streamGenerateContent`, `generate-speech`, `initialUrl`, `403`, `Runtime.enable`, `retry`

## ⚡ TL;DR
1. **Triệu chứng:** Gọi API TTS `/v1beta/models/:model:streamGenerateContent` từ `1.dailypodcast-studio` thỉnh thoảng gặp lỗi `403` tương tự `/v2/responses`.
2. **Nguyên nhân gốc rễ:** `AiStudioAdapter.runSpeechTurn` dùng `runEphemeralSurfaceTask` mở tab mới tại `homeUrl` (`/prompts/new_chat`), sau đó `AiStudioSpeechWorker.executeSpeech` mới gắn Playwright `connectOverCDP` (bật `Runtime.enable`) rồi gọi `page.goto("https://aistudio.google.com/generate-speech?model=...")` khiến trang TTS tải dưới trạng thái CDP đang gắn và dễ bị BotGuard trả `403`; đồng thời `WebGatewayService.generateSpeech` bên `1.dailypodcast-studio` chưa có logic retry `502`/`503` như `runV2Response`.
3. **Cách sửa:** Truyền `initialUrl` (`/generate-speech?model=...`) qua `/v1/turn/start` -> `TurnTabManager.createTurnTab` để Electron tải thẳng trang TTS trước khi Playwright CDP gắn vào (có validate `isAllowedNavigation`), và `AiStudioSpeechWorker` bỏ qua `page.goto` khi URL đã khớp; bên `1.dailypodcast-studio` tách `requestJsonWithRetry` dùng chung cho cả `runV2Response` và `generateSpeech`.

## Thay đổi
- [launcher/electron/browser/control-server.cjs](../../launcher/electron/browser/control-server.cjs), [browser-host.cjs](../../launcher/electron/browser/browser-host.cjs), [turn-tab-manager.cjs](../../launcher/electron/browser/turn-tab-manager.cjs): Hỗ trợ tham số tùy chọn `initialUrl` cho `/v1/turn/start` (kiểm tra `isAllowedNavigation` theo provider) để mở thẳng URL mục tiêu trước khi CDP gắn.
- [src/launcher-browser-host.ts](../../src/launcher-browser-host.ts), [src/adapters/web/runtime-lifecycle.ts](../../src/adapters/web/runtime-lifecycle.ts), [src/adapters/web/engine.ts](../../src/adapters/web/engine.ts): Truyền `initialUrl` từ `runEphemeralSurfaceTask` xuống `acquireWebTurnSurface` -> `/v1/turn/start`.
- [src/adapters/ai-studio/index.ts](../../src/adapters/ai-studio/index.ts), [ai-studio-speech-worker.ts](../../src/adapters/ai-studio/ai-studio-speech-worker.ts): `runSpeechTurn` truyền `initialUrl = buildAiStudioSpeechUrl(request.modelId)` và `executeSpeech` bỏ qua `page.goto` nếu tab đã ở đúng `/generate-speech?model=...`.
- [tests/gemini-speech.test.ts](../../tests/gemini-speech.test.ts): Bổ sung test kiểm chứng `executeSpeech` bỏ qua `page.goto` khi tab đã mở sẵn đúng URL.
- `/Users/huytv/IdeaProjects/1.dailypodcast-studio/electron/web-gateway-service.cjs` & `tests/unit/web-gateway-service.test.cjs`: Tách `requestJsonWithRetry` dùng chung cho `runV2Response` và `generateSpeech` (retry tối đa 2 lần với `502`/`503` có `retryable: true`).
