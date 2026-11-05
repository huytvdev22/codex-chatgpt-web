# 034: Làm sạch ranh giới DOM và chuẩn hóa tên trung lập tại `src/adapters/web/`

## ⚡ TL;DR
- **Triệu chứng:** `src/adapters/web/protocol/fast-path-stream-buffer.ts` còn hàm dead code `extractFastPathFromDom` chứa selector DOM đặc thù Scriptor của M365, và `definition.ts`/`engine.ts` còn dùng các định danh `M365*` (`M365ProtocolErrorCode`, `StrictM365ResponseResult`, `parseStrictM365Response`, `M365ToolBridge`).
- **Nguyên nhân gốc rễ:** Giai đoạn di chuyển cơ học từ `m365-copilot` sang `src/adapters/web/` ưu tiên giữ nguyên toàn bộ file để tránh phá vỡ import và test trước khi tách sạch dấu vết đặc thù M365.
- **Cách sửa:** Xóa `extractFastPathFromDom` khỏi `fast-path-stream-buffer.ts`, bổ sung hàm chuẩn `webHtmlToMarkdown` và `SemanticMarkdownBuffer`, đồng thời chuẩn hóa các kiểu/hàm dùng chung sang tiền tố `Web*` (`WebProtocolErrorCode`, `StrictWebResponseResult`, `StrictWebToolCall`, `parseStrictWebResponse`, `WebToolBridge`) với alias tương thích ngược `M365*`.

## Phạm vi thay đổi
- `src/adapters/web/protocol/fast-path-stream-buffer.ts`: Xóa `extractFastPathFromDom` và `FastPathExtraction` chứa selector DOM M365 không còn được gọi ở bất kỳ đâu; chỉ giữ thuần thuật toán buffer (`FastPathStreamBuffer`, `findSuffixPrefixOverlap`).
- `src/adapters/web/protocol/html-to-markdown.ts` & `src/adapters/web/protocol/semantic-detector.ts`: Tách `webHtmlToMarkdown(html, options)` và `SemanticMarkdownBuffer` / `SemanticMarkdownBlock` dùng chung; giữ `m365HtmlToMarkdown`, `M365MarkdownBuffer`, `M365MarkdownBlock` làm preset/alias tương thích.
- `src/adapters/web/protocol/strict-response-parser.ts` & `src/adapters/web/tools/tool-bridge.ts`: Định nghĩa chính thức `WebProtocolErrorCode`, `StrictWebToolCall`, `StrictWebResponseResult`, `parseStrictWebResponse`, `WEB_RESPONSE_OPEN_TAG`, `WEB_RESPONSE_CLOSE_TAG`, `WebToolBridge`, `WebRawToolCall`, `WebMappedToolCall` và giữ alias `M365*`.
- `src/adapters/web/definition.ts`, `src/adapters/web/engine.ts`, `src/adapters/web/protocol/{validate-response,retry-response,emit-response}.ts`: Chuyển sang dùng tên trung lập `Web*`.

## Kết quả xác minh
- `git diff --check`: Pass.
- `bun run check:architecture`: Pass (`0` circular dependencies, `0` provider reverse imports).
- `bun test`: Pass toàn bộ test suite.
- `bun run build`: Pass.

## Trạng thái
⏳ Chờ User Test & Confirm
