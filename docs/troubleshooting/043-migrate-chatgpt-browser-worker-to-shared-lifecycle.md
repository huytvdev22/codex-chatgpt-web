# 043: Chuyển ChatGPT Browser Worker sang shared lifecycle

## ⚡ TL;DR
- **Triệu chứng:** ChatGPT tự quản lý polling, heartbeat, timeout và abort, khác lifecycle dùng chung của Qwen.
- **Nguyên nhân gốc rễ:** `ChatGptBrowserWorker` chưa kế thừa `BaseWebBrowserWorker`.
- **Cách sửa:** Hardening submit/response identity, chuyển sang shared lifecycle và thêm regression test.

## Trạng thái
✅ Đã Confirm

## Phạm vi

### Giai đoạn 1: Hardening

- Fail-fast nếu không xác nhận được submit trong 15 giây.
- Response baseline lưu ID, số message và nội dung cuối ban đầu.
- Fallback nhận diện response theo count hoặc nội dung thay đổi.
- Dùng cùng identity rule cho polling và copy-salvage.

Commit: `785d6a9`

### Giai đoạn 2: Shared lifecycle

- `ChatGptBrowserWorker` kế thừa `BaseWebBrowserWorker`.
- Shared base quản lý heartbeat, abort, hard timeout, idle timeout và delta streaming.
- Bảo toàn ProseMirror input, clipboard salvage, navigation và conversation ID của ChatGPT.

Commit: `b95362b`

### Giai đoạn 3: Regression test

- Xác nhận worker kế thừa shared base.
- Test response mới không có message ID.
- Test ChatGPT tái sử dụng DOM node nhưng thay đổi nội dung.
- Test submit timeout phải fail-fast.

Commit: `19089ff`

## Kiểm chứng tự động

- ChatGPT suite: `26 pass`, `0 fail`.
- WebTurnEngine suite: `23 pass`, `0 fail`.
- Regression và base worker suite: `18 pass`, `0 fail`.
- Architecture gate: `5 pass`, `0 fail`, `0 cycles`.
- `git diff --check`: Pass.
- Runtime build: Pass.

## User test

1. Khởi động lại runtime và Launcher từ branch `refactor/chatgpt-qwen-worker-lifecycle`.
2. Gửi prompt trong conversation ChatGPT đã có lịch sử, xác nhận không trả response cũ.
3. Gửi hai lượt liên tiếp, xác nhận giữ nguyên conversation.
4. Gửi response dài, xác nhận không kết thúc sớm khi đang streaming.
5. Hủy lượt đang sinh, xác nhận ChatGPT dừng generation và surface không bị treo.
6. Chặn submit, xác nhận báo lỗi sau khoảng 15 giây.
7. Kiểm tra prompt dài không bị chuyển thành file `Pasted text.txt`.
