# Lỗi 006: Lệnh vi phạm SafeCommandGuard làm sập SSE stream và gây lặp kết quả cũ Chunk ID

## ⚡ TL;DR
- **Triệu chứng**: Codex liên tục báo `stream disconnected before completion: [M365 Copilot] [M365 Safe Command Error] Command was rejected by the safety policy.` kèm vòng lặp reconnect 1/5...5/5; M365 trên giao diện web nhận lại output cũ của lệnh trước (`Chunk ID: ...`) và ảo giác rằng bridge server bị cache `tool_result`.
- **Nguyên nhân gốc rễ**: Khi M365 phát lệnh shell vi phạm `SafeCommandGuard` (quét đệ quy, loop foreach đọc file, wildcard), `tool-bridge.ts` ném `Error` trực tiếp làm sập SSE stream của Codex. Codex không chạy được lệnh mới nên không có output mới, khi retry nó gửi lại `tool_result` cũ sang M365.
- **Cách sửa**: 
  1. Trong `strict-response-parser.ts`: Thêm mã lỗi `DISALLOWED_COMMAND` vào `M365ProtocolErrorCode` và kiểm tra `SafeCommandGuard.validateShellCommand(cmd)` ngay khi bóc tách `<tool_call>` để trả về `protocol_error` tường minh.
  2. Trong `tool-validator.ts`: Bổ sung kiểm tra `SafeCommandGuard` trong `validateExecCommand` để chặn sớm các lệnh shell vi phạm.
  3. Trong `templates.ts`: Thêm nhánh xử lý riêng cho `DISALLOWED_COMMAND` trong `buildFormatRetryPrompt()` để gửi hướng dẫn rõ ràng yêu cầu AI chuyển sang dùng `read_file` (<= 150 dòng) hoặc `list_dir` thay vì crash stream.
  4. Trong `index.ts`: Gán mã lỗi `DISALLOWED_COMMAND` khi bắt gặp vi phạm an toàn để kích hoạt format retry vòng lặp.

---

## Chi Tiết Kỹ Thuật

- **File cập nhật**:
  - `src/adapters/m365-copilot/translation/strict-response-parser.ts`: Thêm `DISALLOWED_COMMAND` và validate `SafeCommandGuard` trong `parseFunctionToolCall`.
  - `src/adapters/m365-copilot/tools/tool-validator.ts`: Validate `SafeCommandGuard` trong `validateExecCommand`.
  - `src/adapters/m365-copilot/prompts/templates.ts`: Tối ưu nội dung `buildFormatRetryPrompt` khi vấp `DISALLOWED_COMMAND`.
  - `src/adapters/m365-copilot/tools/tool-bridge.ts`: Bổ sung chi tiết rule và guidance vào thông báo lỗi.
  - `src/adapters/m365-copilot/index.ts`: Phân loại mã lỗi `DISALLOWED_COMMAND` khi kiểm tra tool call.
  - `tests/m365-rawresponse-verification.test.ts`: Thêm các test case kiểm tra việc phát hiện lệnh vi phạm và sinh prompt retry an toàn (bao gồm test case tái hiện 100% response thực tế từ M365 chứa `Get-ChildItem ... -Recurse`).
- **Trạng thái**: ⏳ Chờ User Test & Confirm

