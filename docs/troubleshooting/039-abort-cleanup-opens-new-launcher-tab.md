# 039: Abort xong tiếp tục hội thoại làm Launcher mở tab mới

## ⚡ TL;DR
- **Triệu chứng:** Stop một lượt đang sinh nội dung, sau đó tiếp tục cùng hội thoại thì Launcher mở thêm tab mới.
- **Nguyên nhân gốc rễ:** `phase=end` dùng lại `AbortSignal` đã hủy nên request cleanup không tới Launcher; surface cũ mắc ở trạng thái `running`.
- **Cách sửa:** Khi signal đã abort, gửi `phase=end` không kèm signal để Launcher giải phóng surface; thêm regression test xác nhận cleanup của lượt aborted vẫn chạy.

## Trạng thái
✅ Đã Confirm

## Phạm vi sửa

- `src/adapters/web/runtime-lifecycle.ts`
  - Vẫn dùng `AbortSignal` để dừng browser work.
  - Không truyền signal đã abort vào terminal cleanup `phase=end`.
  - Launcher nhận được `status=aborted` và giải phóng tab đang chạy.
- `tests/web-turn-engine.test.ts`
  - Khóa hành vi `phase=end` cho ba trạng thái `completed`, `failed`, `aborted`.
  - Xác nhận cleanup của lượt aborted không nhận signal đã hủy.

## Kiểm chứng tự động

```bash
bun test tests/web-turn-engine.test.ts
```

Kết quả: `23 pass`, `0 fail`.

`bun run typecheck` hiện vẫn lỗi do các module/export ChatGPT Web cũ bị thiếu trên toàn repository, không phát sinh từ hai file của bản sửa này.

## User test

1. Gửi prompt trong một conversation M365.
2. Nhấn Stop khi M365 đang sinh nội dung.
3. Gửi prompt tiếp theo trong đúng conversation Codex đó.
4. Xác nhận Launcher không tạo thêm tab hoặc renderer.
5. Xác nhận prompt mới được gửi vào đúng hội thoại M365 hiện tại.
