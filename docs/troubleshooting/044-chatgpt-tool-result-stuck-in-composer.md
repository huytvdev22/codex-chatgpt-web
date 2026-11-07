# 044: ChatGPT treo vì tool result còn trong composer

## ⚡ TL;DR
- **Triệu chứng:** Codex đã sửa file nhưng lượt tiếp tục chạy; `tool_result` nằm trong composer ChatGPT và chưa được gửi.
- **Nguyên nhân gốc rễ:** Worker đọc nhầm composer ẩn rỗng và fallback Enter không gửi được ProseMirror multiline.
- **Cách sửa:** Chỉ dùng composer/Send đang hiển thị, click Send trực tiếp và fail-fast sau 15 giây.

## Trạng thái
✅ Đã Confirm

## Bằng chứng

- Codex hiển thị `1 file changed` nhưng vẫn ở trạng thái `Working`.
- ChatGPT đã sinh `apply_patch` đầu tiên.
- Tin nhắn chứa kết quả công cụ vẫn nằm trong composer.
- Nút Send màu xanh vẫn hiển thị, chứng minh tin nhắn chưa được submit.

## Phạm vi sửa

- `src/adapters/chatgpt-web/chatgpt-browser-worker.ts`
  - Tìm `Locator` đang hiển thị thay vì mặc định lấy phần tử đầu tiên.
  - Đọc nội dung trực tiếp từ composer visible.
  - Chỉ xác nhận submit khi Stop visible hoặc composer visible đã rỗng.
  - Tìm lại nút Send visible ở mỗi attempt.
  - Click nút Send trực tiếp, không dùng `force`.
  - Không fallback bằng Enter vì ProseMirror multiline có thể chỉ chèn dòng mới.
  - Ghi log `composerLength` để chẩn đoán trạng thái submit.
- `tests/chatgpt-base-browser-worker.test.ts`
  - Cập nhật fake locator để mô phỏng composer visible và control ẩn.
  - Bảo toàn regression test fail-fast.

## Kiểm chứng tự động

- Regression và base worker suite: `18 pass`, `0 fail`.
- Architecture gate: `5 pass`, `0 fail`, `0 cycles`.
- `git diff --check`: Pass.
- Runtime build: Pass.

## User test

1. Khởi động lại runtime và Launcher để nạp bundle mới.
2. Giao tác vụ cần ít nhất hai lần `apply_patch`.
3. Sau `tool_result` đầu tiên, xác nhận composer được gửi và trở về rỗng.
4. Xác nhận ChatGPT tiếp tục sinh tool call cho file kế tiếp.
5. Xác nhận Codex không còn treo ở `Editing files`.
6. Nếu nút Send không khả dụng, xác nhận lượt báo lỗi sau khoảng 15 giây.
