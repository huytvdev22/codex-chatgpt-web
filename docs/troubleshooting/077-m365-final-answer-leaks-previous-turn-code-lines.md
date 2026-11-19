# Lỗi 077: Final answer M365 bị dính phần nội dung file từ `apply_patch` của lượt trước

> **Trạng thái:** ✅ Đã Confirm
> **Providers:** `m365-copilot`, `web`
> **Keywords:** `data-codex-turn-baseline`, `__m365_code_lines_cache_by_element`, `isLastMsgOld`, `M365DomObserver`, `M365ClipboardSalvage`, `monaco`

## ⚡ TL;DR
- **Triệu chứng:** Sau lượt tạo file (`apply_patch` dài nhiều dòng), tin nhắn `final_answer` ngắn ở lượt kế tiếp hiển thị trên Codex bị lộ `</webResponse>` ở giữa và dính thêm các dòng nội dung từ patch của lượt trước (`+- ...`), dù giao diện M365 Web chỉ hiển thị đúng 11 dòng `<webResponse>...</webResponse>`.
- **Nguyên nhân gốc rễ:** (1) `M365DomObserver.captureStatus()` yêu cầu thêm `isContentUnchanged` khi check `isLastMsgOld`, nên chỉ cần DOM virtualized của tin nhắn lượt 1 thay đổi nhẹ lúc lượt 2 đang gửi/chờ mount, observer nhận nhầm tin nhắn cũ là tin nhắn mới và nạp lại `[data-line-index]` của lượt 1 vào cache toàn cục `window.__m365_code_lines_cache_by_block` theo `blockIdx = 0` (sau khi `insertPrompt` đã xóa); khi lượt 2 xuất hiện với code block `blockIdx = 0` ngắn hơn, các dòng `>= 11` của lượt 1 bị ghép vào đuôi lượt 2; (2) `monaco.editor.getModels()` và fallback `document.querySelectorAll(...).pop()` trong `M365DomObserver` / `M365ClipboardSalvage` / `M365BrowserWorker` đọc theo index/selector toàn trang thay vì cô lập theo DOM element của lượt mới.
- **Cách sửa:** Khóa `isLastMsgOld` dứt khoát theo `baselineCount > 0 && isMarkedBaseline`; đổi cache dòng code sang `WeakMap<HTMLElement, Map<number, string>>` (`__m365_code_lines_cache_by_element`) gắn chặt từng DOM element code block; cô lập Monaco lookup qua `getEditors()` kiểm tra `block.contains(domNode)` / `targetMsg.contains(domNode)`, và không fallback ra ngoài tin nhắn mới trong `M365ClipboardSalvage` / `M365BrowserWorker`.

## Thay đổi
- [src/adapters/m365-copilot/m365-dom-observer.ts](../../src/adapters/m365-copilot/m365-dom-observer.ts): Bỏ `isContentUnchanged` khỏi điều kiện `isLastMsgOld`; chuyển cache virtualized lines sang `WeakMap` theo `HTMLElement`; thay `monaco.editor.getModels()[blockIdx]` bằng `getScopedMonacoText(block)` qua `monaco.editor.getEditors()`.
- [src/adapters/m365-copilot/m365-clipboard-salvage.ts](../../src/adapters/m365-copilot/m365-clipboard-salvage.ts): Ngừng fallback về `aiList[aiList.length - 1]` khi trên trang đã có `[data-codex-turn-baseline]` mà chưa có tin nhắn mới; cô lập Tầng B Monaco qua `getEditors()` thuộc `targetMsg`; bỏ fallback `document.querySelectorAll(...).pop()` ngoài `targetMsg` và thoát sớm khi `targetMsg` không có nút code/copy.
- [src/adapters/m365-copilot/m365-browser-worker.ts](../../src/adapters/m365-copilot/m365-browser-worker.ts): Xóa thêm `__m365_code_lines_cache_by_element` trong `insertPrompt` và ưu tiên `responseState.lastStatus?.hasCodeBlocks` (hoặc selector `:not([data-codex-turn-baseline])`) thay vì quét nút copy toàn trang.
- [tests/m365-turn-isolation.test.ts](../../tests/m365-turn-isolation.test.ts): Bổ sung 3 bài test cô lập DOM/cache/Monaco giữa các lượt hội thoại.
