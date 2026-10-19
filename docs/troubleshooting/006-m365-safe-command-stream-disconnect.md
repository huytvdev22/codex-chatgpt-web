# Lỗi 006: Lệnh vi phạm SafeCommandGuard hoặc công cụ lạ (UNKNOWN_TOOL) làm sập SSE stream và gây lặp kết quả cũ Chunk ID

## ⚡ TL;DR
- **Triệu chứng**: Codex liên tục báo `stream disconnected before completion: [M365 Copilot] [M365 Safe Command Error]...` hoặc `[M365 Tool Capability Error]...` kèm vòng lặp reconnect 1/5...5/5; M365 trên giao diện web nhận lại output cũ của lệnh trước (`Chunk ID: ...`) và ảo giác rằng bridge server bị cache `tool_result`.
- **Nguyên nhân gốc rễ**: Khi M365 phát lệnh shell vi phạm `SafeCommandGuard` (quét đệ quy, loop foreach đọc file, wildcard) hoặc gọi công cụ không được client hỗ trợ ở phiên làm việc (`UNKNOWN_TOOL`), `tool-bridge.ts` ném `Error` trực tiếp ngoài vòng lặp retry làm sập SSE stream của Codex. Codex không chạy được lệnh mới nên không có output mới, khi retry nó gửi lại `tool_result` cũ sang M365.
- **Cách sửa**: 
  1. Trong `strict-response-parser.ts`: Thêm mã lỗi `DISALLOWED_COMMAND` và `UNKNOWN_TOOL` vào `M365ProtocolErrorCode`. Kiểm tra `SafeCommandGuard.validateShellCommand(cmd)` ngay khi bóc tách `<tool_call>` để trả về `protocol_error` tường minh.
  2. Trong `tool-validator.ts`: Bổ sung kiểm tra `SafeCommandGuard` trong `validateExecCommand`. Kiểm tra đối chiếu chính xác công cụ với `clientTools`; nếu công cụ không được hỗ trợ, trả về `UNKNOWN_TOOL` kèm danh sách các công cụ khả dụng `Các công cụ khả dụng: [...]`.
  3. Trong `templates.ts`: Thêm nhánh xử lý riêng cho `DISALLOWED_COMMAND` và `UNKNOWN_TOOL` trong `buildFormatRetryPrompt()` để gửi hướng dẫn rõ ràng yêu cầu AI tự chọn lại công cụ native hợp lệ (`read_file`, `list_dir`, `apply_patch`, `exec_command`) thay vì crash stream.
  4. Trong `index.ts`: Bắt các mã lỗi `DISALLOWED_COMMAND` và `UNKNOWN_TOOL` khi validation thất bại để kích hoạt format retry vòng lặp (gửi lại trong cùng phiên chat thay vì để sập SSE stream).
  5. Trong `tool-bridge.ts`: Bổ sung chi tiết rule và guidance vào thông báo lỗi dự phòng.

---

## Chi Tiết Kỹ Thuật

- **File cập nhật**:
  - `src/adapters/m365-copilot/translation/strict-response-parser.ts`: Thêm `DISALLOWED_COMMAND`, `UNKNOWN_TOOL` và validate `SafeCommandGuard` trong `parseFunctionToolCall`.
  - `src/adapters/m365-copilot/tools/tool-validator.ts`: Validate `SafeCommandGuard` trong `validateExecCommand`, đối chiếu `clientTools` sinh thông báo `UNKNOWN_TOOL` chi tiết.
  - `src/adapters/m365-copilot/prompts/templates.ts`: Thêm prompt retry định dạng cho `DISALLOWED_COMMAND` và `UNKNOWN_TOOL`.
  - `src/adapters/m365-copilot/tools/tool-bridge.ts`: Bổ sung chi tiết rule và guidance vào thông báo lỗi.
  - `src/adapters/m365-copilot/index.ts`: Phân loại mã lỗi `DISALLOWED_COMMAND` và `UNKNOWN_TOOL` trong vòng lặp validation format retry.
  - `tests/m365-rawresponse-verification.test.ts`: Thêm các test case kiểm tra việc phát hiện lệnh vi phạm và gọi công cụ lạ, sinh prompt retry an toàn (bao gồm test case tái hiện 100% response thực tế từ M365 chứa `Get-ChildItem ... -Recurse`).
  - `tests/m365-apply-patch.test.ts` & `tests/m365-plan-mode.test.ts`: Tinh chỉnh test suite tương thích.
- **Trạng thái**: ⏳ Chờ User Test & Confirm


