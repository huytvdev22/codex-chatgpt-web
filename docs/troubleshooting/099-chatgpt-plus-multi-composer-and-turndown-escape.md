# 099: Treo 20s `waitForSelector` ở Turn 2 ChatGPT Plus (2 ProseMirror) & Turndown escape `\<webResponse>`

> **Trạng thái:** ✅ Đã Confirm
> **Providers:** `chatgpt`, `web`, `playwright`  
> **Keywords:** `waitForSelector`, `ProseMirror`, `resolved to 2 elements`, `waitForVisibleComposer`, `normalizeCopiedChatGptSnippet`, `Turndown`, `MISSING_RESPONSE_ENVELOPE`

## ⚡ TL;DR
1. **Triệu chứng:** Trên ChatGPT Plus (`/c/{id}`), Turn 2 bị timeout 20s ở `waitForSelector(CHATGPT_SELECTORS.composer)` với log *"locator resolved to 2 elements. Proceeding with the first one"*; đồng thời khi `gpt-6` trả lời trong thẻ `<p>` thay vì `<pre><code>`, phản hồi bị lỗi `MISSING_RESPONSE_ENVELOPE`.
2. **Nguyên nhân gốc rễ:** (a) Playwright `waitForSelector` chỉ kiểm tra phần tử đầu tiên trong DOM — khi ChatGPT giữ một `ProseMirror` ẩn ở vị trí đầu tiên và `ProseMirror` hiển thị ở vị trí thứ hai, `waitForSelector(..., { state: "visible" })` chờ hết 20s; (b) `webHtmlToMarkdown` (Turndown) escape `` ` `` và `<webResponse>` trong `<p>` thành `` \` `` và `\<webResponse>`.
3. **Cách sửa:** Thay `waitForSelector` bằng `waitForVisibleComposer()` dùng `findVisibleLocator()` trong [chatgpt-browser-worker.ts](../../src/adapters/chatgpt/chatgpt-browser-worker.ts), và phục hồi Turndown escape ở biên transport/envelope trong `normalizeCopiedChatGptSnippet()` tại [chatgpt-dom-observer.ts](../../src/adapters/chatgpt/chatgpt-dom-observer.ts).
