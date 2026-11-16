# 058 - Lỗi `element is outside of the viewport` khi click nút Send trên M365 Copilot

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Ngày phát hiện:** 2026-11-16  
> **Phạm vi:** `src/adapters/m365-copilot/m365-browser-worker.ts`

## ⚡ TL;DR
1. **Triệu chứng:** Khi gửi prompt tới M365 Copilot lúc tab chạy ngầm trong Launcher, server trả `502` với lỗi `[m365-worker] Không thể xác nhận prompt đã được gửi sau 10 lần thử (editorLength=52)`; log Playwright báo `element is visible, enabled and stable -> scrolling into view if needed -> done scrolling -> element is outside of the viewport`.
2. **Nguyên nhân gốc rễ:** `sendLocator.click()` dùng hit-test viewport chặt của Playwright thất bại trên `WebContentsView` offscreen / layout responsive của M365 (hoặc `findVisibleLocator` có thể chọn phần tử hiển thị ngoài viewport) mà chưa có bước fallback bằng CDP mouse click.
3. **Cách sửa:** Trong [m365-browser-worker.ts](../../src/adapters/m365-copilot/m365-browser-worker.ts), ưu tiên phần tử nằm trong tọa độ viewport ở `findVisibleLocator`, và khi `sendLocator.click()` thất bại thì `scrollIntoView({ block: "center", inline: "center" })` rồi fallback sang `page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)`.

