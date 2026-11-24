# 098: Treo `connectOverCDP: Timeout 20000ms exceeded` khi bật hoặc chuyển sang provider `Sign in with Chrome` chưa đăng nhập

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Providers:** `chatgpt`, `ai-studio`, `m365-copilot`, `launcher`, `electron`, `playwright`  
> **Keywords:** `connectOverCDP`, `Timeout 20000ms exceeded`, `syncPrimaryViewAfterSwitch`, `IDLE_BROWSER_URL`, `WebContentsView`, `usesExternalChromeLogin`

## ⚡ TL;DR
1. **Triệu chứng:** Khi UI Launcher chuyển sang provider dùng Chrome ngoài chưa đăng nhập (ví dụ `chatgpt` hoặc profile `ai-studio` mới), mọi lượt chạy adapter qua Playwright (`m365-copilot`, `ai-studio`, `chatgpt`) đều lỗi `connectOverCDP: Timeout 20000ms exceeded`.
2. **Nguyên nhân gốc rễ:** Trong `syncPrimaryViewAfterSwitch` ở `launcher/electron/browser/browser-host.cjs`, nhánh `usesExternalChromeLogin && !effectiveAuth` dùng điều kiện `if (currentUrl && currentUrl !== IDLE_BROWSER_URL ...)`, khiến `WebContentsView` vừa tạo mới có `getURL() === ""` không được nạp `IDLE_BROWSER_URL`. Target CDP chưa commit URL (`url: ""`) làm `playwright.chromium.connectOverCDP()` treo hết timeout trên toàn trình duyệt.
3. **Cách sửa:** Đổi điều kiện nạp `IDLE_BROWSER_URL` thành `if (!currentUrl || (currentUrl !== IDLE_BROWSER_URL && currentUrl !== "about:blank"))` trong [browser-host.cjs](../../launcher/electron/browser/browser-host.cjs) và bổ sung unit test tại [browser-host.test.cjs](../../launcher/tests/browser-host.test.cjs).
