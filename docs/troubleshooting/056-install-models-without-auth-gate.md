# 056 - Bỏ điều kiện bắt buộc đăng nhập khi Install models (`launcher:setup-core`)

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày thực hiện:** 2026-11-16  
> **Phạm vi:** `src/setup.ts`, `launcher/electron/app/ipc-router.cjs`, `tests/setup-lifecycle.test.ts`, `launcher/tests/renderer-wiring.test.cjs`

## ⚡ TL;DR
1. **Triệu chứng:** Nhấn **Install models** trong Launcher bị lỗi `Launcher Web browser session could not be verified: Launcher returned invalid Web browser session evidence` khi provider đang chọn (vd. `ai-studio`) chưa đăng nhập dù đã có `smokePassedByProvider` từ provider khác (`m365`).
2. **Nguyên nhân gốc rễ:** `ipc-router.cjs` cho phép vượt qua check auth bằng `anyProviderSmokePassed`, nhưng `src/setup.ts` vẫn gọi `inspectLauncherBrowserHost()` (`/v1/session/inspect`) vốn bắt buộc `authenticated === true` trên provider đang active.
3. **Cách sửa:** Gỡ bỏ điều kiện chặn theo `probeAuthentication()` và `smokePassed` trong `launcher:setup-core` tại `ipc-router.cjs`, đồng thời đổi `src/setup.ts` sang dùng `inspectLauncherBrowserHostLiveness()` để chỉ xác minh descriptor/CDP liveness mà không yêu cầu đăng nhập trước khi cài đặt catalog vào Codex.

## Chi tiết thay đổi
- [launcher/electron/app/ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs): Gỡ nhánh gọi `browserHost.probeAuthentication()` và check `smokePassed` trong `handle("launcher:setup-core")`.
- [src/setup.ts](../../src/setup.ts): Thay `inspectLauncherBrowserHost(...)` bằng `inspectLauncherBrowserHostLiveness(...)` với `{ expectedProfile: "production" }`.
- [launcher/tests/renderer-wiring.test.cjs](../../launcher/tests/renderer-wiring.test.cjs) và [tests/setup-lifecycle.test.ts](../../tests/setup-lifecycle.test.ts): Cập nhật và bổ sung test xác nhận cài đặt models hoạt động không phụ thuộc trạng thái đăng nhập browser.
