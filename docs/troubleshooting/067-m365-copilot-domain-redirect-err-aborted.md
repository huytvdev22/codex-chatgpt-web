# Lỗi 067: M365 Copilot redirect sang `copilot.cloud.microsoft` gây lỗi `ERR_FAILED (-2)` và `net::ERR_ABORTED`

> **Trạng thái:** ⏳ Chờ User Test & Confirm
> **Providers:** `m365-copilot`, `launcher`, `electron`
> **Keywords:** `copilot.cloud.microsoft`, `m365.cloud.microsoft`, `ERR_ABORTED`, `ERR_FAILED`, `restrictNavigation`, `navigate`

## ⚡ TL;DR
- **Triệu chứng:** Gửi tin nhắn qua Codex bị ngắt stream với lỗi `ERR_FAILED (-2) loading 'https://m365.cloud.microsoft/chat'` hoặc `goto: net::ERR_ABORTED at https://m365.cloud.microsoft/chat`, dù tab trình duyệt Launcher mở thủ công vẫn vào được `copilot.cloud.microsoft/chat`.
- **Nguyên nhân gốc rễ:** Microsoft chuyển hướng M365 Copilot sang domain `copilot.cloud.microsoft` (không khớp `m365.cloud.microsoft` hay `*.m365.cloud.microsoft` / `*.microsoft.com`), làm `restrictNavigation` trong `m365-turn-surface.cjs` chặn redirect và `M365BrowserWorker.navigate()` ép `page.goto` lại `m365.cloud.microsoft/chat` do so sánh chuỗi URL cứng.
- **Cách sửa:** Cho phép `copilot.cloud.microsoft` (và `*.cloud.microsoft`) trong `m365-turn-surface.cjs`, `m365-browser-provider.cjs`, `m365-smoke-tester.cjs`, `conversation-url.ts`; cập nhật `M365BrowserWorker.navigate()` nhận diện trang Chat/Login hợp lệ trên cả hai domain và chịu lỗi `ERR_ABORTED` khi đang redirect.

## Thay đổi
- [m365-turn-surface.cjs](file:///d:/HUYTVDEV/codex-chatgpt-web/launcher/electron/browser/providers/m365/m365-turn-surface.cjs): Thêm `copilot.cloud.microsoft` và `.cloud.microsoft` vào `allowedM365Navigation`.
- [m365-browser-provider.cjs](file:///d:/HUYTVDEV/codex-chatgpt-web/launcher/electron/browser/providers/m365/m365-browser-provider.cjs): Hỗ trợ `copilot.cloud.microsoft` trong `M365_AUTH_PROVIDER_HOSTS`, `parseM365ConversationId`, `isMicrosoftAuthOrAppUrl`, `allowedM365AuthUrl`, và `probeAuthentication` (đồng thời loại trừ `/login` trên `.cloud.microsoft`).
- [m365-smoke-tester.cjs](file:///d:/HUYTVDEV/codex-chatgpt-web/launcher/electron/browser/providers/m365/m365-smoke-tester.cjs): Nhận diện `copilot.cloud.microsoft` là app M365 hợp lệ khi chạy smoke test.
- [conversation-url.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/conversation-url.ts) & [index.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/index.ts): Hỗ trợ origin `https://copilot.cloud.microsoft` cho `parseM365ConversationId`, `buildM365ConversationUrl` (qua `resolveM365Origin`), bổ sung `isM365ChatHomeUrl`, `isM365LoginUrl`.
- [m365-browser-worker.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/m365-browser-worker.ts): Không ép `page.goto` khi đã ở `m365.cloud.microsoft/chat` hoặc `copilot.cloud.microsoft/chat`, phát hiện sớm trạng thái đăng nhập hết hạn và chịu lỗi `ERR_ABORTED` khi redirect.
- Tests: [m365-conversation.test.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/tests/m365-conversation.test.ts), [m365-base-browser-worker.test.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/tests/m365-base-browser-worker.test.ts), [browser-providers.test.cjs](file:///d:/HUYTVDEV/codex-chatgpt-web/launcher/tests/browser-providers.test.cjs).

