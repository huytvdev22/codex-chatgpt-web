# 111 — Gemini Web dùng 3-backtick bọc `<webResponse>` khiến Assistant bỏ lọt XML tool call ra Telegram

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Phạm vi / Providers:** `assistant`, `gemini`, `streaming`, `protocol`

## ⚡ TL;DR
- **Triệu chứng:** Khi dùng model Gemini Web trên Trợ lý Telegram, bot hiển thị thẳng khối `<webResponse><tool_call>...</tool_call></webResponse>` lên khung chat thay vì thực thi công cụ.
- **Nguyên nhân gốc rễ:** Gemini Web tự rút vỏ bọc Action Turn từ 4-backtick (```` ````markdown ````) xuống 3-backtick (```` ```markdown ````). `AssistantResponseParser` chỉ khớp đúng `` `{4} `` nên rơi xuống `stripMarkdownCode()` và xóa sạch khối 3-backtick rồi trả về `final_answer`; `AssistantStreamGate` cũng chỉ bóc/chặn `>= 4` backtick.
- **Cách sửa:** Cho phép `AssistantResponseParser` và `AssistantStreamGate` nhận cả **3-backtick lẫn 4-backtick** làm transport wrapper **khi nội dung mở đầu bằng `<webResponse>`**, chuẩn hóa về 4-backtick trước khi đưa qua `parseStrictWebResponse`, nhưng vẫn giữ nguyên toàn bộ các code block 3-backtick thông thường trong Final Answer.

## Chi tiết thay đổi
- [`src/assistant/assistant-response-parser.ts`](../../src/assistant/assistant-response-parser.ts):
  - Thêm `extractOuterTransportFence()` và cập nhật `TRAILING_WEBRESPONSE_FENCE_REGEX`, `unwrapOptionalAssistantEnvelope()` hỗ trợ `` `{3,4} `` khi thân mở đầu bằng `<webResponse\b` (và bảo vệ không khớp gộp nhiều code block 3-backtick rời nhau).
  - Chuẩn hóa thành dạng ` ````markdown\n...\n```` ` trước khi gọi `parseStrictWebResponse()`.
- [`src/assistant/assistant-stream-gate.ts`](../../src/assistant/assistant-stream-gate.ts):
  - Bổ sung mở đầu/đuôi 3-backtick vào `OPTIONAL_OPEN_WRAPPERS` và `TRAILING_MARKER_PREFIXES`.
  - Cập nhật `stripOptionalOpeningWrappers()` và `findExecutableToolMarkerIndex()` để giữ `BUFFERING` / cắt sớm khi khối 3-backtick mở đầu bằng `<webResponse`, đồng thời stream nguyên vẹn code block 3-backtick thường (như ```` ```ts ```` hoặc ```` ```markdown\n# ... ````).
- Bổ sung unit & route test trong [`tests/assistant-prompt-and-parser.test.ts`](../../tests/assistant-prompt-and-parser.test.ts), [`tests/assistant-stream-gate.test.ts`](../../tests/assistant-stream-gate.test.ts) và [`tests/assistant-routes-isolation.test.ts`](../../tests/assistant-routes-isolation.test.ts).
