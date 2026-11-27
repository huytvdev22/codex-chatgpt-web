# 108 — Gemini Web Đứng Yên Sau Khi Select Model Do `.fill()` Prompt Dài Trên Quill Editor

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Phạm vi / Providers:** `gemini`, `web`, `assistant`, `playwright`

## ⚡ TL;DR
- **Triệu chứng:** Khi gửi tin nhắn trên phiên có lịch sử dài (resume thread cũ trên `1.codex-assistant` hoặc VS Code Codex), Electron Launcher mở trang `gemini.google.com/app`, chọn xong model/thinking rồi đứng yên ~28–30 giây không điền prompt và không gửi.
- **Nguyên nhân gốc rễ:** `GeminiBrowserWorker.insertPrompt()` gọi `composerLocator.fill(promptText, { timeout: 10_000 })` cho mọi độ dài (kể cả prompt ~94,890 ký tự vì `AssistantPromptCompiler` nhồi nguyên văn toàn bộ `priorHistory` / `<tool_result>` cũ), làm Playwright + Quill `.ql-editor` (`contenteditable="true"`) bị đơ ~28.7 giây.
- **Cách sửa:** Chỉ dùng `.fill()` khi `promptText.length <= 1_500`, các prompt dài hơn đi thẳng qua `page.evaluate()` dựng `<p>` bằng `DocumentFragment` + `editor.replaceChildren(fragment)` (~`487ms`), đồng thời giới hạn `AssistantPromptCompiler` chỉ giữ lịch sử gần nhất (`16_000` ký tự, `<tool_result>` cũ tối đa `350` ký tự).

## Tóm tắt kỹ thuật
- [gemini-browser-worker.ts](../../src/adapters/gemini/gemini-browser-worker.ts): Giữ `.fill(promptText, { timeout: 3_000 })` với prompt ngắn `<= 1_500` ký tự (tương tự `ChatGptBrowserWorker`); prompt dài hơn bơm thẳng bằng `DocumentFragment` trong 1 lần `replaceChildren()` để tránh hàng nghìn DOM reflow.
- [assistant-prompt-compiler.ts](../../src/assistant/assistant-prompt-compiler.ts): Giảm `DEFAULT_ASSISTANT_MAX_PROMPT_CHARS` từ `95_000` xuống `36_000` (hoặc `64_000` khi có `trailingToolResults`), duyệt ngược `priorHistory` từ mới đến cũ trong ngân sách `16_000` ký tự.
- Kiểm thử: [gemini-browser-worker.test.ts](../../tests/gemini-browser-worker.test.ts), [assistant-prompt-and-parser.test.ts](../../tests/assistant-prompt-and-parser.test.ts), và chạy tái hiện thật với `CodexAppServerClient.resumeThread()` (`insertPrompt` giảm từ `28,726ms` xuống `487ms`, `promptLen` giảm từ `94,890` xuống `17,972`).
