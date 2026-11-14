# 051 - Turndown thoát ký tự Markdown (`\_`, `\*`, `\[`) làm hỏng JSON Structured Output trên M365

> **Trạng thái:** ⏳ Chờ User Test & Confirm
> **Providers:** `core`, `web`, `m365-copilot`

## ⚡ TL;DR
- **Triệu chứng:** Khi Codex ở chế độ `Approve for me` (`codex_output_schema`) hoặc sinh tiêu đề, M365 đã trả JSON hợp lệ (`{"risk_level":"low","user_authorization":"high","outcome":"allow",...}`) nhưng parser vẫn báo `INVALID_JSON_SCHEMA_OUTPUT` và retry nhiều lần tới khi chỉ còn `{"outcome":"allow"}`.
- **Nguyên nhân gốc rễ:** M365 render JSON dưới dạng đoạn văn `<p>` thay vì code block; `m365HtmlToMarkdown` (`Turndown`) tự chèn `\` trước `_`, `*`, `[`, `]`, `` ` `` (biến `"risk_level"` thành `"risk\_level"`), tạo escape bất hợp lệ khiến `JSON.parse()` ném `SyntaxError`.
- **Cách sửa:** Bổ sung `unescapeTurndownMarkdown()` fallback trong `parseAndValidateJsonSchemaResponse()` khi `JSON.parse` trực tiếp thất bại, đồng thời hướng dẫn `buildStructuredJsonOutputProtocol()` ưu tiên bọc trong khối ```` ```json ... ``` ````.

## Thay đổi chính
- [src/adapters/web/protocol/json-schema-response.ts](../../src/adapters/web/protocol/json-schema-response.ts): Khôi phục các chuỗi thoát Markdown do Turndown sinh ra (`\_`, `\*`, `\[`, `\]`, `` \` ``, v.v.) mà vẫn bảo toàn `\\\\` khi `JSON.parse()` mặc định báo lỗi.
- [src/adapters/web/prompt/templates.ts](../../src/adapters/web/prompt/templates.ts): Nhắc ưu tiên bọc JSON trong khối code ```` ```json ... ``` ```` để tránh M365 render thành `<p>`.
- [tests/web-structured-output.test.ts](../../tests/web-structured-output.test.ts): Bổ sung test case thực tế từ payload `codex_output_schema` chứa nhiều chuỗi thoát Turndown liên tiếp.

