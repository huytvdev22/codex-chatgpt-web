# 042: Qwen không xác nhận submit và phụ thuộc message ID

## ⚡ TL;DR
- **Triệu chứng:** Qwen có thể tiếp tục chờ dù prompt chưa gửi, hoặc không nhận ra assistant response mới khi DOM không có ID.
- **Nguyên nhân gốc rễ:** Submit timeout chỉ cảnh báo; response identity phụ thuộc tuyệt đối vào thuộc tính `id`.
- **Cách sửa:** Fail-fast sau 10 giây và fallback nhận diện response bằng số message cùng nội dung ban đầu.

## Trạng thái
✅ Đã Confirm

## Phạm vi sửa

- `src/adapters/qwen-web/qwen-browser-worker.ts`
  - Ném lỗi khi không xác nhận được prompt đã gửi trong 10 giây.
  - Lưu `assistantCount` và `initialLatestText` trong baseline.
  - Ưu tiên nhận diện response mới bằng ID.
  - Fallback theo message index khi phần tử không có ID.
  - Fallback theo thay đổi nội dung khi Qwen tái sử dụng DOM node.
  - Áp dụng cùng một identity rule cho polling, DOM extraction và copy-salvage.

## Kiểm chứng tự động

```bash
git diff --check
bun test tests/qwen-web-adapter.test.ts tests/qwen-conversation-store.test.ts
bun run check:architecture
bun run build
```

Kết quả:

- `git diff --check`: Pass.
- Qwen tests: `13 pass`, `0 fail`.
- Architecture gate: `5 pass`, `0 fail`, `0 cycles`.
- Runtime build: Pass.

## User test

1. Khởi động lại runtime và Launcher.
2. Gửi prompt mới trong conversation Qwen đã có assistant response.
3. Xác nhận adapter không trả lại response cũ.
4. Mô phỏng hoặc quan sát trường hợp nút Send không nhận thao tác.
5. Xác nhận lượt thất bại rõ ràng sau khoảng 10 giây thay vì chờ response vô hạn.
6. Gửi tiếp ít nhất hai lượt trong cùng conversation để kiểm tra conversation binding.
