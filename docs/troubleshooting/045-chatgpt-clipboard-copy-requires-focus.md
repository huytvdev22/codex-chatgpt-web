# 045: ChatGPT không copy được response vào clipboard

## ⚡ TL;DR
- **Triệu chứng:** ChatGPT hiện toast `Couldn't copy to clipboard` khi worker trích xuất code block.
- **Nguyên nhân gốc rễ:** Worker gọi `HTMLElement.click()` trong `page.evaluate()`, không tạo trusted user activation cho Clipboard API.
- **Cách sửa:** Đưa tab lên trước, đánh dấu response mới và dùng Playwright `Locator.click()` trên đúng nút Copy.

## Trạng thái
✅ Đã Confirm

## Bằng chứng

- Assistant response đã hoàn tất và code block Markdown đã hiển thị.
- Toast của ChatGPT ghi: `The content wasn't copied. Try again while ChatGPT is focused`.
- Composer không còn chứa tool result, nên lỗi không thuộc luồng submit.

## Phạm vi sửa

- `src/adapters/chatgpt-web/chatgpt-browser-worker.ts`
  - Gọi `page.bringToFront()` trước khi copy.
  - Đánh dấu wrapper của assistant response mới bằng token tạm thời.
  - Tìm nút `Copy code`, fallback sang `Copy message`.
  - Click bằng Playwright `Locator.click()` để tạo trusted user activation.
  - Không còn phát synthetic pointer/mouse events hoặc gọi `HTMLElement.click()`.
  - Nếu clipboard vẫn không khả dụng, fallback sang DOM text như trước.
  - Xóa marker tạm sau khi hoàn tất.

## Kiểm chứng tự động

- ChatGPT và base worker suites: `35 pass`, `0 fail`.
- Architecture gate: `5 pass`, `0 fail`, `0 cycles`.
- `git diff --check`: Pass.
- Runtime build: Pass.

## User test

1. Khởi động lại runtime và Launcher để nạp bundle mới.
2. Yêu cầu ChatGPT tạo một `apply_patch` dài.
3. Xác nhận toast `Couldn't copy to clipboard` không còn xuất hiện.
4. Xác nhận Codex nhận đủ patch, giữ nguyên xuống dòng và áp dụng thành công.
5. Tiếp tục ít nhất một vòng `tool_result` để kiểm tra tool loop không bị treo.
