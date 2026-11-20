# Lỗi 093: Google Sign-In báo "Couldn't sign you in / This browser or app may not be secure" khi đăng nhập profile AI Studio mới

> **Trạng thái:** ✅ Đã Confirm  
> **Providers:** `ai-studio`, `electron`, `launcher`  
> **Keywords:** `accounts.google.com/v3/signin/rejected`, `navigator.webdriver`, `AutomationControlled`, `disable-blink-features`, `remote-debugging-port`, `multi-profile`

## ⚡ TL;DR
1. **Triệu chứng:** Khi thêm profile Google AI Studio mới (`Account 2`, partition `persist:codex-web-aistudio-p2`), nhập Gmail và bấm Next thì Google chuyển về `accounts.google.com/v3/signin/rejected` báo trình duyệt không an toàn.
2. **Nguyên nhân gốc rễ:** `launcher/electron/main.cjs` bật `--remote-debugging-port` cho Playwright CDP nhưng không tắt Blink feature `AutomationControlled`, khiến Chromium 148 (Electron 42) tự đặt `navigator.webdriver = true` trên mọi `WebContentsView`.
3. **Cách sửa (A + B):**
   - **Phương án A:** Thêm `configureAutomationSignalsPolicy(app.commandLine)` (`disable-blink-features=AutomationControlled`) trước `app.whenReady()` để `navigator.webdriver === false`.
   - **Phương án B (triệt để khi Google vẫn chặn Embedded Chromium):** Bổ sung luồng **Sign in with Chrome** (`ExternalChromeLoginService` + `src/chrome-session-extractor.ts`): mở cửa sổ Google Chrome thật với profile tạm sạch (không debugging/automation) để user đăng nhập bình thường (hỗ trợ cả Passkey/2FA), sau đó trích xuất offline cookies (`__Host-*`, `__Secure-*`, `.google.com`) + `localStorage` qua `playwright-core` và nạp vào Electron partition của profile đang chọn rồi xóa ngay folder tạm.

## Thay đổi
- [launcher/electron/main.cjs](../../launcher/electron/main.cjs): Bổ sung `configureAutomationSignalsPolicy()` (`AutomationControlled`), `runChromeSessionExtractor()` qua `embeddedRuntimeInvocation`, và truyền `ExternalChromeLoginService` vào `BrowserHost`.
- [src/chrome-session-extractor.ts](../../src/chrome-session-extractor.ts) & [src/cli.ts](../../src/cli.ts): Thêm subcommand `browser extract-chrome-session` dùng Playwright `launchPersistentContext` offline + macOS Keychain flags để trích xuất cookie & `localStorage` của Google/AI Studio an toàn.
- [launcher/electron/browser/external-chrome-login-service.cjs](../../launcher/electron/browser/external-chrome-login-service.cjs): Điều phối mở Chrome thật với profile tạm, dừng Chrome, ánh xạ cookie sang Electron (`__Host-*`, host-only vs `.domain`, `sameSite`), và dọn thư mục tạm.
- [launcher/electron/browser/browser-host.cjs](../../launcher/electron/browser/browser-host.cjs), [ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs), [preload.cjs](../../launcher/electron/preload.cjs), [App.tsx](../../launcher/src/App.tsx), [types.ts](../../launcher/src/types.ts), [styles.css](../../launcher/src/styles.css): Thêm `startExternalLogin` / `completeExternalLogin` / `cancelExternalLogin` và thanh hỗ trợ **Sign in with Chrome** / **Import session** ngay trên Browser & Setup UI.
- Tests: [tests/chrome-session-extractor.test.ts](../../tests/chrome-session-extractor.test.ts), [launcher/tests/browser-host.test.cjs](../../launcher/tests/browser-host.test.cjs), [launcher/tests/renderer-wiring.test.cjs](../../launcher/tests/renderer-wiring.test.cjs).
