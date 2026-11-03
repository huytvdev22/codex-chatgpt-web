# Lỗi 016: Tự động lưu raw request vào scratch

> **Trạng thái:** ⏳ Chờ User Test & Confirm
> **Phạm vi:** `server`, `privacy`, `filesystem`
> **Keywords:** `scratch`, `raw request`, `codex-raw.txt`, `history`, `CODEX_RAW_DUMP_DIR`

## ⚡ TL;DR
- **Triệu chứng:** Mỗi request tự động tạo `codex-raw.txt` và `history/turn-*.json` trong thư mục `scratch`.
- **Nguyên nhân gốc rễ:** `responseRequest()` luôn gọi `dumpRawCodexRequest()` sau khi đọc JSON body.
- **Cách sửa:** Xóa toàn bộ raw-dump helper, lời gọi ghi file và test dành riêng cho tính năng này.

## Thay đổi

- `src/server.ts`
  - Xóa `getRawDumpBaseDir()`.
  - Xóa `dumpRawCodexRequest()`.
  - Bỏ lời gọi tự động ghi raw request trong `responseRequest()`.
  - Dọn các import filesystem và path không còn sử dụng.
- `tests/raw-dump-history.test.ts`
  - Xóa test của tính năng raw dump đã bị loại bỏ.

## Phạm vi không thay đổi

- Không xóa dữ liệu cũ đang tồn tại trong `scratch`.
- Không thay đổi conversation store của các adapter.
- Không thay đổi thư mục tạm được tạo và tự dọn trong test/build.

## Kiểm thử

- Không còn tham chiếu tới `dumpRawCodexRequest`, `getRawDumpBaseDir`, `CODEX_RAW_DUMP_DIR`, `codex-raw.txt` hoặc `raw-dump-history`.
- Typecheck toàn codebase vẫn có các lỗi ChatGPT Web tồn tại từ trước, không liên quan đến thay đổi này.
