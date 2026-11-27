# 110 — Sửa Bảng Markdown Bị Vỡ / Lặp Đôi & Nâng Cấp Telegram Rich Messages (Bot API 10.1+)

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Phạm vi / Providers:** `web`, `assistant`, `bridge`, `telegram`, `chatgpt`, `gemini`, `ai-studio`

## ⚡ TL;DR
- **Triệu chứng:** Khi AI Web trả về bảng GFM (`<table>`), tin nhắn trên Telegram bị vỡ từng ô xuống dòng (`|\nSTT\n|`), lặp đôi toàn bộ nội dung 2 lần (nửa trên vỡ, nửa dưới sạch), và không hiển thị thành bảng native đẹp trên Telegram.
- **Nguyên nhân gốc rễ:** (1) `src/adapters/web/markdown.ts` chèn `\n\n` vào `<p>` bên trong `<td>`/`<th>` và biến path trong ô bảng thành `[...](<...>)` khi DOM streaming; (2) `AssistantStreamGate.finalizeAsFinalAnswer()` nối `\n\n${cleanFinal}` khi snapshot DOM lệch bản Clipboard, còn `bridge.ts` chưa chốt `finalText` vào `output_item.done`; (3) `1.codex-assistant` còn dùng `telegramify-markdown` (`MarkdownV2`) thay vì `sendRichMessage` / `sendRichMessageDraft` của Bot API 10.1+.
- **Cách sửa:** Gộp gọn ô bảng `th`/`td` trong Turndown (`gfmTableCellCompact` + `gfmTableRowCompact`), truyền `done.finalText` qua `bridge.ts` vào `response.output_item.done` (bỏ nối đôi ở `AssistantStreamGate`), và nâng cấp `1.codex-assistant` dùng `sendRichMessage` (ngưỡng 28,000 ký tự, có fallback legacy `sendMessage`) + `sendRichMessageDraft` cho DM (`can_stop`, refresh 15s, hỗ trợ `stopped_message_generation`).

## Chi tiết thay đổi
- `codex-chatgpt-web`:
  - [`src/adapters/web/markdown.ts`](../../src/adapters/web/markdown.ts): Thêm `isInsideTableCell`, `gfmTableCellCompact`, `gfmTableRowCompact`, và bỏ `inlineFilePath` bên trong `<td>`/`<th>`.
  - [`src/types.ts`](../../src/types.ts) & [`src/bridge.ts`](../../src/bridge.ts): Thêm `finalText?: string` trên sự kiện `done` để `closeCurrentMessage()` phát bản chốt cuối sạch vào `response.output_text.done`, `response.content_part.done`, `response.output_item.done` (Zero-Touch luồng VS Code `/v1/responses`).
  - [`src/assistant/assistant-stream-gate.ts`](../../src/assistant/assistant-stream-gate.ts) & [`src/assistant/assistant-responses-service.ts`](../../src/assistant/assistant-responses-service.ts): Bỏ nối `\n\n${candidate}` khi mismatch, truyền `finalText: finalParsed.content` vào `done`.
- `1.codex-assistant`:
  - `src/telegram/telegram-api-client.ts`: Thêm `sendRichMessage`, `sendRichMessageDraft` và đăng ký `"stopped_message_generation"` trong `allowed_updates`.
  - `src/telegram/telegram-bot-service.ts`: DM dùng `sendRichMessageDraft` (refresh 15s, hỗ trợ Stop trực tiếp trên draft), Group/Topic dùng placeholder truyền thống rồi gửi `sendRichMessage` + xóa placeholder, ngưỡng 28,000 ký tự trước khi đính kèm `.md`, fallback tự động về `MarkdownV2`/`HTML`/plain text khi API từ chối.
