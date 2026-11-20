# Lỗi 094: Profile đã đăng nhập (`Default`) vẫn bị hiển thị màn hình "Sign in with Chrome" & trạng thái Setup sai lệch

> **Trạng thái:** ✅ Đã Confirm  
> **Providers:** `ai-studio`, `electron`, `launcher`, `profiles`  
> **Keywords:** `switchProviderProfile`, `cachedAuth`, `hasAuthCookies`, `syncProfilesAuthFromSessions`, `probeAuthentication`, `showExternalChromeCard`

## ⚡ TL;DR
1. **Triệu chứng:** (a) Khi từ `Account 3` vào Setup bấm `Use` cho `Default`, profile đã đăng nhập vẫn hiện chấm xám (`○`) và kẹt màn `Sign in with Chrome`; (b) Khi bấm `Open` ở Setup cho profile đã đăng nhập (chấm xanh `●` như `Account 2`), Launcher lại mở cửa sổ Google Chrome và bắt đăng nhập lại.
2. **Nguyên nhân gốc rễ:** (a) `syncPrimaryViewAfterSwitch()` chỉ dựa vào cờ cache JSON `activeProfile.authenticated` mà bỏ qua kiểm tra cookie partition; (b) `initializePrimaryView()` & Setup chưa sync từ partition cookies và `probeAuthentication()`/cookie listener chéo xóa nhầm cờ auth khi đang loading; (c) `BrowserHost.openLogin()` gọi thẳng `startExternalLogin()` vô điều kiện cho `ai-studio` kể cả khi profile đã đăng nhập (`Open` từ Setup gọi `openLogin`).
3. **Cách sửa:** Bổ sung `AiStudioBrowserProvider.hasAuthCookies()` kiểm tra Google auth cookies thực tế trong `session.fromPartition(...)`; đồng bộ trạng thái mọi profile trong `syncProfilesAuthFromSessions()` lúc startup và khi mở Setup (`launcher:list-providers`); khôi phục auth từ session cookies trong `syncPrimaryViewAfterSwitch()`; trong `openLogin()` chỉ gọi `startExternalLogin()` khi profile thực sự chưa đăng nhập, còn đã đăng nhập thì mở thẳng `homeUrl` trong Launcher; lọc đúng session active trong `bindAuthenticationChanges()` và không để `showExternalChromeCard` che turn tab đang mở.

## Thay đổi
- [launcher/electron/browser/external-chrome-login-service.cjs](../../launcher/electron/browser/external-chrome-login-service.cjs): Xuất `GOOGLE_AUTH_COOKIE_NAMES` để tái sử dụng kiểm tra Google session cookies.
- [launcher/electron/browser/providers/base-browser-provider.cjs](../../launcher/electron/browser/providers/base-browser-provider.cjs) & [ai-studio-browser-provider.cjs](../../launcher/electron/browser/providers/ai-studio/ai-studio-browser-provider.cjs): Thêm `hasAuthCookies(browserSession)` và trả thêm `signInButton` trong `probeAuthentication`.
- [launcher/electron/browser/browser-host.cjs](../../launcher/electron/browser/browser-host.cjs) & [ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs): Thêm `syncProfilesAuthFromSessions()`, kiểm tra `hasAuthCookies` trước khi mask switch profile, chống cookie listener chéo giữa các partition, bảo vệ cờ auth khi đang loading dở, và sync lại khi mở Setup (`launcher:list-providers`).
- [launcher/src/App.tsx](../../launcher/src/App.tsx): Gọi `listProviders()` khi vào `SetupSurface`, ưu tiên trạng thái auth của active profile, và không để `showExternalChromeCard` đè lên `turnTab` đang mở.
- [launcher/tests/browser-host.test.cjs](../../launcher/tests/browser-host.test.cjs): Bổ sung test khôi phục auth từ partition cookies khi switch profile và giữ cờ auth khi đang loading mà cookies vẫn còn.
