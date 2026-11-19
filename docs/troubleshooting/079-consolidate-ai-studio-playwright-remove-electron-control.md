# 079: Chuyển hẳn Google AI Studio sang Playwright CDP và gỡ bỏ hoàn toàn `electron-control`

> **Trạng thái:** ✅ Đã Confirm  
> **Providers:** `ai-studio`, `speech`, `web`, `launcher`, `electron`  
> **Keywords:** `ai-studio`, `ai-studio-pw`, `playwright-cdp`, `electron-control`, `ElectronSurfaceClient`, `SurfaceActionExecutor`, `/v1/surface/action`

## ⚡ TL;DR
1. **Triệu chứng / Bối cảnh:** Giai đoạn A/B test giữa `ai-studio` (`electron-control`) và `ai-studio-pw` (`playwright-cdp`) đã có kết quả nghiêng hẳn về bản Playwright CDP; cần bỏ code `electron-control` và hợp nhất về một provider `ai-studio` duy nhất.
2. **Nguyên nhân gốc rễ:** Duy trì song song `ai-studio` (`ElectronSurfaceClient` + `SurfaceActionExecutor` ~1.470 dòng qua `POST /v1/surface/action`) và `ai-studio-pw` gây trùng lặp adapter, phân mảnh model slug (`ai-studio-pw/gemini-4-hydrogen`) và làm phức tạp khung `BaseWebBrowserWorker<..., TSurface>` / `WebTurnEngine`.
3. **Cách sửa:** Chuyển toàn bộ implementation Playwright CDP từ `src/adapters/ai-studio-pw/` sang [src/adapters/ai-studio/](../../src/adapters/ai-studio/index.ts) (dùng `Page`, `AiStudioBrowserWorker`, `AiStudioSpeechWorker`, `AiStudioDomObserver`, `ai-studio-human-timing.ts`); xóa `src/adapters/ai-studio-pw/`, `ElectronSurfaceClient`, `SurfaceActionExecutor`, route `POST /v1/surface/action`, cờ `browserTransport` / `skipCdpConnection` / generic `TSurface`; giữ nguyên `launcher/electron/browser/providers/ai-studio/` để Electron Launcher tiếp tục cấp tab & cookie cho Playwright kết nối CDP.

## Thay đổi
- [src/adapters/ai-studio/](../../src/adapters/ai-studio/index.ts): Thay worker/observer/speech/conversation-url bằng bản Playwright CDP (`Page`), bổ sung [ai-studio-human-timing.ts](../../src/adapters/ai-studio/ai-studio-human-timing.ts), xóa `attachments.ts` & `capability-picker.ts` cũ, xóa toàn bộ thư mục `src/adapters/ai-studio-pw/`.
- [src/adapters/adapter-registry.ts](../../src/adapters/adapter-registry.ts), [src/models/model-registry.ts](../../src/models/model-registry.ts), [src/services/gemini-speech-service.ts](../../src/services/gemini-speech-service.ts): Gỡ đăng ký `ai-studio-pw`, chỉ giữ provider `ai-studio` (`ai-studio/gemini-4-hydrogen`).
- [src/adapters/web/](../../src/adapters/web/engine.ts): Xóa `electron-surface-client.ts`, gỡ `browserTransport`, `electronClient`, `skipCdpConnection` và generic `TSurface` tại `definition.ts`, `launcher-runtime.ts`, `runtime-lifecycle.ts`, `engine.ts`, `base-browser-worker.ts`, `index.ts`.
- [launcher/electron/browser/](../../launcher/electron/browser/control-server.cjs): Xóa `surface-action-executor.cjs`, gỡ `executeSurfaceAction` trong `browser-host.cjs` và route `POST /v1/surface/action` trong `control-server.cjs`.
- [tests/](../../tests/ai-studio-adapter.test.ts), [launcher/tests/](../../launcher/tests/control-server.test.cjs), [docs/](../../docs/system-architecture.md): Gộp test Playwright vào `ai-studio-adapter.test.ts`, chuyển `gemini-speech.test.ts` sang mock Playwright `Page`, xóa `ai-studio-pw-adapter.test.ts` và `surface-action-executor.test.cjs`, cập nhật tài liệu kiến trúc.
