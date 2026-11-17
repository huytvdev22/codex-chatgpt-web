# Lỗi 068: Fallback click Send trong `submitPrompt` treo 60s làm Launcher abort turn (`helper_heartbeat_expired`)

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Providers:** `m365-copilot`, `web`, `playwright`, `launcher`  
> **Keywords:** `submitPrompt`, `helper_heartbeat_expired`, `M365 Copilot turn aborted`, `boundingBox`, `evaluate`, `fd00290`

## ⚡ TL;DR
1. **Triệu chứng:** Khi gửi prompt tới M365 Copilot, Codex hiện `Reconnecting 1/5... 2/5` rồi báo `stream disconnected before completion: M365 Copilot turn aborted`, hoặc M365 trả lời *"hai lượt gọi `exec_command` trước chưa trả về `<tool_result>`"* dù người dùng không thấy tool chạy.
2. **Nguyên nhân gốc rễ:** Trong `M365BrowserWorker.submitPrompt()` (bổ sung ở `fd00290`), khi `sendLocator.click({ timeout: 1_000 })` vừa gửi được prompt thì M365 lập tức thay nút Send bằng Stop khiến Playwright throw `TimeoutError`. Nhánh `catch` không kiểm tra xem prompt đã gửi chưa mà gọi ngay `sendLocator.evaluate()` và `sendLocator.boundingBox()` không có `{ timeout }` -> treo 30s + 30s = 60s trước khi vào `waitForCompletion` (chưa gửi heartbeat), khiến Launcher kích hoạt `helper_heartbeat_expired` và abort turn trong khi M365 vẫn chạy nền.
3. **Cách sửa:** Trong [m365-browser-worker.ts](../../src/adapters/m365-copilot/m365-browser-worker.ts), thêm `isPromptSubmitted()` kiểm tra ngay sau khi `sendLocator.click` lỗi (nếu đã gửi thì thoát ngay), gắn `{ timeout: 1_000 }` cho `evaluate`/`boundingBox`/`textContent`/`isEnabled` và gửi `sendHeartbeat(options)` ở [base-browser-worker.ts](../../src/adapters/web/browser/base-browser-worker.ts) sau `prepareProvider` cũng như trong mỗi vòng `submitPrompt`.

## Thay đổi
- [src/adapters/m365-copilot/m365-browser-worker.ts](../../src/adapters/m365-copilot/m365-browser-worker.ts): Tách `isPromptSubmitted()`, kiểm tra trạng thái đã submit ngay trong `catch` của `sendLocator.click`, đặt `{ timeout: 1_000 }` cho `evaluate`, `boundingBox`, `textContent`, `isEnabled`, và gọi `sendHeartbeat` mỗi lần thử gửi.
- [src/adapters/web/browser/base-browser-worker.ts](../../src/adapters/web/browser/base-browser-worker.ts): Tách `sendHeartbeat()` dùng chung và gửi heartbeat ngay sau `prepareProvider()`.
- [tests/m365-base-browser-worker.test.ts](../../tests/m365-base-browser-worker.test.ts): Kiểm chứng truyền `timeout: 1_000` cho `evaluate`/`boundingBox`, gửi heartbeat trong `submitPrompt`, và thoát ngay khi `click` timeout nhưng prompt đã được gửi.

