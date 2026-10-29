# Lỗi 010: Final answer nhắc cú pháp envelope bị nhận nhầm là nhiều envelope

## ⚡ TL;DR
- **Triệu chứng**: Final answer hợp lệ bị từ chối với mã `MULTIPLE_RESPONSE_ENVELOPES` khi nội dung Markdown nhắc lại tên thẻ response.
- **Nguyên nhân gốc rễ**: Parser tìm chuỗi thẻ trong toàn bộ payload, nên nhầm dữ liệu Markdown với cấu trúc điều khiển lồng nhau.
- **Cách sửa**: Chỉ phát hiện envelope lồng hoặc envelope sibling tại biên cấu trúc; giữ các chuỗi tương tự nằm trong final answer như dữ liệu opaque.

---

## Chi tiết kỹ thuật

- **File cập nhật**:
  - `src/adapters/m365-copilot/translation/strict-response-parser.ts`
  - `tests/m365-strict-response-protocol.test.ts`
- **Thay đổi**:
  - Bỏ kiểm tra `inner.includes(...)` trên toàn bộ final-answer payload.
  - Chỉ từ chối khi payload bắt đầu bằng một envelope lồng hoặc chứa hai envelope sibling liên tiếp.
  - Bổ sung regression test cho nội dung Markdown nhắc trực tiếp tên thẻ response.
  - Bổ sung regression test cho ví dụ envelope đã HTML-escape.
- **Kiểm thử**:
  - `bun test tests/m365-strict-response-protocol.test.ts`: 27 pass, 0 fail.
  - `bun test tests/m365-rawresponse-verification.test.ts`: 9 pass, 0 fail.
  - `git diff --check`: không có lỗi whitespace từ các file thay đổi.
  - `bun run typecheck`: chưa thể dùng làm quality gate vì codebase hiện có nhiều lỗi TypeScript tồn tại từ trước ở các module ChatGPT Web và test không liên quan.
- **Trạng thái**: ⏳ Chờ User Test & Confirm
