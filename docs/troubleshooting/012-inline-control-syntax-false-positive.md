# Lỗi 012: Final answer nhắc cú pháp XML bị nhận nhầm là mixed content và lệnh shell batch read bị chặn

## ⚡ TL;DR
- **Triệu chứng**: Final answer giải thích protocol hoặc giao thức XML `<tool_call>`, `<custom_tool_call>` (kể cả không có backtick hoặc trích dẫn trong code block) bị từ chối với mã `MIXED_TOOL_AND_TEXT_CONTENT`; lệnh khảo sát nhiều file bằng PowerShell loop `$files = @(...) foreach (...) { Get-Content ... }` bị từ chối với mã `BATCH_READ_DISALLOWED`.
- **Nguyên nhân gốc rễ**: Parser kiểm tra sự xuất hiện của chuỗi thẻ XML thô bằng regex mà không phân biệt giữa đề cập thuật ngữ trong văn bản với cấu trúc payload JSON/Patch có thể thực thi (executable action); `SafeCommandGuard` chặn cứng nhắc vòng lặp shell đọc file làm cản trở model khảo sát repo nhanh.
- **Cách sửa**: 
  1. Thêm `stripMarkdownCode` và `hasExecutableToolAction` trong `strict-response-parser.ts`: Chỉ từ chối khi thực sự có executable tool frame (kèm JSON object payload hoặc patch directives) trộn lẫn với narrative text ngoài code block; opaque markdown chứa các thẻ XML đơn lẻ hoặc code block tutorial được trả về `final_answer`.
  2. Gỡ bỏ rule `BATCH_READ_DISALLOWED` trong `SafeCommandGuard` để model tự do dùng vòng lặp shell khảo sát mã nguồn.

---

## Chi tiết kỹ thuật

- **File cập nhật**:
  - `src/adapters/m365-copilot/translation/strict-response-parser.ts`
  - `src/adapters/m365-copilot/tools/safe-command-guard.ts`
  - `tests/m365-user-reported-mixed-content.test.ts`
  - `tests/m365-rawresponse-verification.test.ts`
- **Thay đổi cụ thể**:
  - `strict-response-parser.ts`:
    - Loại bỏ hàm regex đơn giản `hasReservedControlMarker`.
    - Triển khai `stripMarkdownCode` loại bỏ fenced code blocks (` ```...``` `) và inline code (`` `...` ``).
    - Triển khai `hasExecutableToolAction` kiểm tra xem có function tool call thực sự (`<tool_call>\s*\{` hoặc cặp thẻ đóng/mở có JSON payload) hoặc patch call thực sự (`<custom_tool_call>` với `*** Begin Patch`) hay không.
    - Bảo vệ `stripMarkdownCode` cho thought block check.
  - `safe-command-guard.ts`:
    - Bỏ kiểm tra `isPowerShellBatchReadLoop` và `isPosixBatchReadLoop` (`BATCH_READ_DISALLOWED`).
- **Kiểm thử**:
  - `bun test tests/m365-user-reported-mixed-content.test.ts`: 7/7 pass (Case 1, 2, 3 cả có backtick lẫn không backtick đều ra `final_answer`, Case 4 chạy foreach read thành công ra `tool_calls`).
  - Toàn bộ test suite M365: `219 pass, 0 fail` across 24 files.
- **Trạng thái**: ✅ Đã Confirm
