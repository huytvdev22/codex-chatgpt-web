# [117] AI Studio lỗi `Quota exceeded` (daily limit) không dừng ngay mà bị Codex retry lặp

- **Trạng thái:** `✅ Đã Confirm`
- **Providers / Modules:** `ai-studio`, `errors`, `web`, `server`

## ⚡ TL;DR
1. **Triệu chứng:** Khi AI Studio trả toast `[AI Studio] [AI Studio Web Error] error Failed to generate content, Quota exceeded: you have reached the daily limit of requests for this model ...`, Codex CLI không dừng ngay mà báo `stream disconnected before completion` sau vòng retry.
2. **Nguyên nhân gốc rễ:** `isInsufficientQuotaMessage()` trong [src/lib/errors.ts](../../src/lib/errors.ts) chưa khớp cụm `"quota exceeded"` / `"reached the daily limit"` / `"daily limit of requests"`, nên lỗi bị phân loại nhầm thành HTTP `502` (`upstream_error`) thay vì `429` (`insufficient_quota`), khiến `WebTurnEngine` không gắn `retryable: false` lên sự kiện `error` và `response.failed`.
3. **Cách sửa:** Bổ sung nhận diện `"quota exceeded"`, `"exceeded your quota"`, `"reached the daily limit"`, `"reached your daily limit"`, `"daily limit of requests"` vào `isInsufficientQuotaMessage()`; chặn retry tạm thời cho các biến thể `daily limit` ở `isTransientAiStudioWebError()`, mở rộng regex bắt toast/turn ở `AiStudioDomObserver`, và gắn `retryable: false` ở nhánh `catch` fallback của `ResponsesService`.

## Thay đổi
- [src/lib/errors.ts](../../src/lib/errors.ts): Mở rộng `isInsufficientQuotaMessage()` để phân loại lỗi quota AI Studio sang `{ type: "insufficient_quota", code: "insufficient_quota" }` và HTTP `429`.
- [src/adapters/ai-studio/ai-studio-dom-observer.ts](../../src/adapters/ai-studio/ai-studio-dom-observer.ts): Bổ sung `daily limit` vào regex quét lỗi toast và fallback `rawText`.
- [src/adapters/ai-studio/ai-studio-browser-worker.ts](../../src/adapters/ai-studio/ai-studio-browser-worker.ts): Chặn `isTransientAiStudioWebError()` thử lại khi gặp biến thể `daily limit` / `daily quota` / `insufficient_quota` / `exceeded your quota`.
- [src/services/responses-service.ts](../../src/services/responses-service.ts): Gắn `retryable: false` khi lỗi rơi vào `catch` fallback mà mang mã `insufficient_quota`.
- [tests/web-turn-engine.test.ts](../../tests/web-turn-engine.test.ts) & [tests/ai-studio-adapter.test.ts](../../tests/ai-studio-adapter.test.ts): Bổ sung unit test cho thông báo `Quota exceeded` của AI Studio.
