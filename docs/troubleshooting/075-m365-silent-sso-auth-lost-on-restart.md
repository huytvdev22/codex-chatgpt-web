# Lỗi 075: M365 Copilot báo hết hạn đăng nhập khi khởi động lại Launcher và tab tự refresh không chờ SSO

> **Trạng thái:** ⏳ Chờ User Test & Confirm
> **Providers:** `m365-copilot`, `launcher`, `electron`
> **Keywords:** `Silent SSO`, `login.microsoftonline.com`, `ERR_ABORTED`, `refreshAuthentication`, `gotoM365Url`, `loadCommittedBrowserSurface`

## ⚡ TL;DR
- **Triệu chứng:** Mỗi khi tắt bật lại Launcher (`bun run --cwd launcher build && bun run --cwd launcher start`), adapter M365 thường báo lỗi `Phiên đăng nhập M365 Copilot đã hết hạn hoặc chưa đăng nhập. Vui lòng đăng nhập lại trong Launcher.` và tab tự refresh không chờ xác thực, dù cookie đăng nhập vẫn còn nguyên.
- **Nguyên nhân gốc rễ:** Khi mới bật app hoặc token hết hạn, Microsoft thực hiện Silent SSO redirect qua `login.microsoftonline.com` vài giây. Tuy nhiên `TurnTabManager` coi trang login là đã commit xong, `M365BrowserWorker.navigate()` lập tức ép `page.goto` (refresh đè) hoặc ném lỗi ngay mà không chờ SSO, còn `BrowserHost.refreshAuthentication()` lúc startup gọi `probeAuthentication()` rồi `parkIdlePrimaryView()` ngay trước khi SSO kịp hoàn tất.
- **Cách sửa:** Bổ sung `waitForM365AuthSettle` trong `M365BrowserWorker` để chờ Silent SSO redirect hoàn tất (chỉ thoát sớm nếu thấy form nhập tay ổn định), bỏ qua `ERR_ABORTED (-3)` khi redirect trong `loadCommittedBrowserSurface`, bổ sung `M365BrowserProvider.waitForAuthenticationSettle()` cho `BrowserHost.refreshAuthentication()`, và flush toàn bộ active sessions trong `persistSession()`.

## Thay đổi
- [m365-browser-worker.ts](file:///Users/huytv/IdeaProjects/1.m365-codex/codex-chatgpt-web/src/adapters/m365-copilot/m365-browser-worker.ts): Thêm `waitForM365AuthSettle()` và `detectInteractiveLoginPrompt()` trước khi kết luận hết hạn đăng nhập; tránh `page.goto()` đè lên quá trình SSO đang chạy và giữ nguyên origin (`copilot.cloud.microsoft` / `m365.cloud.microsoft`) sau khi SSO hoàn tất.
- [turn-tab-manager.cjs](file:///Users/huytv/IdeaProjects/1.m365-codex/codex-chatgpt-web/launcher/electron/browser/turn-tab-manager.cjs): Cho phép `loadCommittedBrowserSurface()` bỏ qua `ERR_ABORTED (-3)` khi đang redirect HTTPS surface (`typeof isCommittedUrl === "function"`).
- [base-browser-provider.cjs](file:///Users/huytv/IdeaProjects/1.m365-codex/codex-chatgpt-web/launcher/electron/browser/providers/base-browser-provider.cjs) & [m365-browser-provider.cjs](file:///Users/huytv/IdeaProjects/1.m365-codex/codex-chatgpt-web/launcher/electron/browser/providers/m365/m365-browser-provider.cjs): Thêm hook `waitForAuthenticationSettle()` để chờ Silent SSO ổn định trước khi probe & park primary view.
- [browser-host.cjs](file:///Users/huytv/IdeaProjects/1.m365-codex/codex-chatgpt-web/launcher/electron/browser/browser-host.cjs): Gọi `providerObj.waitForAuthenticationSettle?.(contents)` trong `refreshAuthentication()` và flush mọi session đang hoạt động trong `persistSession()`.
- Tests: [m365-base-browser-worker.test.ts](file:///Users/huytv/IdeaProjects/1.m365-codex/codex-chatgpt-web/tests/m365-base-browser-worker.test.ts), [browser-host.test.cjs](file:///Users/huytv/IdeaProjects/1.m365-codex/codex-chatgpt-web/launcher/tests/browser-host.test.cjs), [browser-providers.test.cjs](file:///Users/huytv/IdeaProjects/1.m365-codex/codex-chatgpt-web/launcher/tests/browser-providers.test.cjs).
