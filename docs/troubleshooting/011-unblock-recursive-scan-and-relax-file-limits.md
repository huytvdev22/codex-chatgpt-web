# Lỗi 011: Lệnh quét đệ quy bị từ chối và giới hạn đọc file làm giảm quyền tự chủ của model

## ⚡ TL;DR
- **Triệu chứng**: Mô hình bị từ chối khi thực thi lệnh quét đệ quy (`Get-ChildItem -Recurse`, `tree /F`, `ls -R`), và các file đọc bị giới hạn cứng 150 dòng hoặc `MAX_TOOL_RESULT_CHARS` khiến kết quả tool bị cắt ngắn ở giữa.
- **Nguyên nhân gốc rễ**: `SafeCommandGuard` chặn cứng rule `RECURSIVE_SCAN_DISALLOWED`, trong khi `templates.ts` áp đặt các hạn chế cứng nhắc (1-3 file, tối đa 150 dòng) và `compiler.ts`/`assembler.ts` giới hạn `MAX_TOOL_RESULT_CHARS` làm mất nội dung tool.
- **Cách sửa**: Bỏ chặn rule `RECURSIVE_SCAN_DISALLOWED` trong `SafeCommandGuard`, viết lại prompts trong `templates.ts` để model tự chủ quyết định, và bỏ hoàn toàn `MAX_TOOL_RESULT_CHARS` để giữ nguyên vẹn 100% nội dung phản hồi của công cụ.

---

## Chi tiết kỹ thuật

- **File cập nhật**:
  - `src/adapters/m365-copilot/tools/safe-command-guard.ts`
  - `src/adapters/m365-copilot/prompts/templates.ts`
  - `src/adapters/m365-copilot/prompts/compiler.ts`
  - `src/adapters/m365-copilot/prompts/assembler.ts`
  - `tests/m365-rawresponse-verification.test.ts`
- **Thay đổi cụ thể**:
  - `SafeCommandGuard`: Bỏ khối logic chặn `isRecursiveTree`, `isPowerShellRecursiveScan`, `isPosixRecursiveScan`. Các lệnh quét đệ quy được phép chạy bình thường.
  - `templates.ts`: Thay thế các đoạn prompt giới hạn cứng nhắc về số file/số dòng (1-5 file, 150 dòng, 500 dòng) bằng chỉ dẫn trao quyền tự do cho model tự quyết định số file và phạm vi đọc phù hợp với bài toán.
  - `compiler.ts` & `assembler.ts`: Bỏ hoàn toàn hằng số `MAX_TOOL_RESULT_CHARS`. Kết quả tool (`res.output`, `h.content`) được truyền nguyên vẹn 100% vào prompt mà không bị cắt tỉa ở giữa `[... Đã lược bớt ...]`.
- **Kiểm thử**:
  - Chạy `bun test (Get-ChildItem -Path tests -Filter "m365*.test.ts").FullName`: **212 pass, 0 fail**, 2376 assertions.
- **Trạng thái**: ⏳ Chờ User Test & Confirm
