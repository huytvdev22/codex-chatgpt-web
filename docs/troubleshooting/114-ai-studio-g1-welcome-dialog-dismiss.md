# 114: Tự động đóng hộp thoại `Welcome to AI Studio` (`#g1-welcome-dialog`) chặn thao tác khi mở Google AI Studio

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Providers:** `ai-studio`, `speech`, `launcher`  
> **Keywords:** `g1-welcome-dialog`, `ms-g1-welcome-dialog`, `ms-tos-disclaimer`, `Continue`, `cdk-overlay-backdrop`, `dismissAiStudioWelcomeDialogs`

## ⚡ TL;DR
1. **Triệu chứng:** Khi mở Google AI Studio (đặc biệt trên tài khoản Google AI plan / profile mới), hộp thoại `Welcome to AI Studio` (`#g1-welcome-dialog` / `ms-g1-welcome-dialog`) bật lên kèm lớp phủ `cdk-overlay-backdrop`, chặn toàn bộ thao tác chọn model, nhập prompt, chạy TTS hoặc smoke test khiến turn lỗi ngay.
2. **Nguyên nhân gốc rễ:** Các worker AI Studio trước đây chỉ đóng `.urlcontext-nudge` (`dismissObstructingNudges`) và toast lỗi, chưa phát hiện và bấm nút `Continue` (`button.ms-button-primary`) trên modal `mat-dialog-container#g1-welcome-dialog` / `ms-tos-disclaimer`.
3. **Cách sửa:** Bổ sung helper `dismissAiStudioWelcomeDialogs(page)` trong `ai-studio-human-timing.ts` (bấm `Continue` bằng `clickResilient` + fallback DOM click và chờ dialog ẩn hoàn toàn, chi phí ~0ms khi không hiện), tích hợp vào `AiStudioBrowserWorker` (`dismissObstructingNudges` & cuối `prepareProvider`), `AiStudioSpeechWorker` (`prepareEditor` & trước khi bấm Run), `AiStudioModelDiscovery` và `AiStudioSmokeTester`.

## Thay đổi
- [src/adapters/ai-studio/ai-studio-human-timing.ts](../../src/adapters/ai-studio/ai-studio-human-timing.ts): Thêm `AI_STUDIO_WELCOME_DIALOG_SELECTOR`, `AI_STUDIO_WELCOME_DIALOG_ACTION_SELECTOR` và `dismissAiStudioWelcomeDialogs(page)`.
- [src/adapters/ai-studio/ai-studio-browser-worker.ts](../../src/adapters/ai-studio/ai-studio-browser-worker.ts): Gọi `dismissAiStudioWelcomeDialogs(page)` đầu `dismissObstructingNudges(page)` và sau pha settle trong `prepareProvider(page)` để bắt cả dialog bật muộn sau RPC Google One.
- [src/adapters/ai-studio/ai-studio-speech-worker.ts](../../src/adapters/ai-studio/ai-studio-speech-worker.ts): Gọi `dismissAiStudioWelcomeDialogs(page)` trong `prepareEditor(page)` và trước khi bấm `Run`.
- [src/adapters/ai-studio/model-discovery.ts](../../src/adapters/ai-studio/model-discovery.ts): Gọi `dismissAiStudioWelcomeDialogs(page)` trước khi mở bảng chọn model.
- [launcher/electron/browser/providers/ai-studio/ai-studio-smoke-tester.cjs](../../launcher/electron/browser/providers/ai-studio/ai-studio-smoke-tester.cjs): Tự đóng `#g1-welcome-dialog` / `ms-g1-welcome-dialog` trước khi điền prompt smoke test.
- [tests/ai-studio-adapter.test.ts](../../tests/ai-studio-adapter.test.ts): Bổ sung unit test cho `dismissAiStudioWelcomeDialogs` và luồng `insertPrompt` khi có `#g1-welcome-dialog`.
