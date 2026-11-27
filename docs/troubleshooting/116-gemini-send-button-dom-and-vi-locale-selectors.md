# 116: Gemini Web Đứng Yên Sau Khi Chọn Model Do Selector `sendButton` & Nhãn Giao Diện Tiếng Việt

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Providers:** `gemini`, `web`, `assistant`, `launcher`  
> **Keywords:** `GEMINI_SELECTORS`, `gem-icon-button.send-button`, `send-button-container`, `Gửi tin nhắn`, `Ngừng tạo câu trả lời`, `EFFORT_LABELS`, `GeminiBrowserWorker`, `submitPrompt`

## ⚡ TL;DR
1. **Triệu chứng:** Khi gửi tin nhắn từ cả `1.codex-assistant` lẫn `codex-vscode` với model `gemini/4-hydrogen`, Gemini Web chọn xong model, điền xong prompt vào composer rồi đứng yên 15 giây và báo lỗi `[gemini-worker] Không thể xác nhận prompt đã được gửi trong 15 giây.`
2. **Nguyên nhân gốc rễ:** (a) Gemini Web đổi cấu trúc DOM nút Send/Stop: class `.send-button` và `.submit`/`.stop` nằm trên thẻ cha `<gem-icon-button>` trong `[data-test-id="send-button-container"]`, không còn nằm trên thẻ `<button>` nên `button.send-button` không khớp; (b) Tài khoản Gemini đang để ngôn ngữ Tiếng Việt (`lang="vi"`) khiến `aria-label` là `"Gửi tin nhắn"`, `"Ngừng tạo câu trả lời"`, `"Sao chép"`, `"Khôi phục"`, `"Bật/Tắt cuộc trò chuyện tạm thời"` và submenu Thinking level là `"Thấp"`, `"Trung bình"`, `"Cao"` — làm các selector/regex thuần tiếng Anh bị lệch hoàn toàn.
3. **Cách sửa:** Bổ sung selector cấu trúc độc lập ngôn ngữ (`[data-test-id="send-button-container"] gem-icon-button.send-button.submit button`, `gem-icon-button.send-button.stop button`, `copy-button button`, `regenerate-button button`) kèm fallback Tiếng Việt trong [selectors.ts](../../src/adapters/gemini/selectors.ts) và [gemini-smoke-tester.cjs](../../launcher/electron/browser/providers/gemini/gemini-smoke-tester.cjs); mở rộng `EFFORT_LABELS` trong [capability-picker.ts](../../src/adapters/gemini/capability-picker.ts), `cleanGeminiUiLabel` trong [model-discovery.ts](../../src/adapters/gemini/model-discovery.ts) và `GEMINI_WEB_ERROR_REGEX` trong [gemini-dom-observer.ts](../../src/adapters/gemini/gemini-dom-observer.ts).

## Chi tiết thay đổi
- [src/adapters/gemini/selectors.ts](../../src/adapters/gemini/selectors.ts): Cập nhật `sendButton`, `stopButton`, `tempChatOnButton`, `tempChatOffButton`, `uploadAndToolsButton`, `copyCodeButton`, `copyAssistantResponseButton`, `redoButton` ưu tiên selector cấu trúc `<gem-icon-button>` / `<copy-button>` / `<regenerate-button>` độc lập ngôn ngữ và fallback nhãn Tiếng Việt.
- [src/adapters/gemini/capability-picker.ts](../../src/adapters/gemini/capability-picker.ts): Cập nhật `EFFORT_LABELS` nhận diện thêm `Thấp` / `Nhanh`, `Trung bình`, `Cao`.
- [src/adapters/gemini/model-discovery.ts](../../src/adapters/gemini/model-discovery.ts): Chuẩn hóa `Tự động` (`Thích ứng với nhu cầu của bạn`) về `"Auto"` (`gemini/auto`) trong `cleanGeminiUiLabel`.
- [src/adapters/gemini/gemini-dom-observer.ts](../../src/adapters/gemini/gemini-dom-observer.ts): Bổ sung cụm từ báo lỗi Tiếng Việt vào `GEMINI_WEB_ERROR_REGEX` và `captureStatus`.
- [launcher/electron/browser/providers/gemini/gemini-smoke-tester.cjs](../../launcher/electron/browser/providers/gemini/gemini-smoke-tester.cjs): Đồng bộ selector nút Send mới cho Smoke Test Gemini.
- [tests/gemini-browser-worker.test.ts](../../tests/gemini-browser-worker.test.ts) & [tests/model-discovery-parsers.test.ts](../../tests/model-discovery-parsers.test.ts): Bổ sung unit test xác minh selector đa ngôn ngữ, chọn Thinking level Tiếng Việt và parse `Auto` Tiếng Việt.
