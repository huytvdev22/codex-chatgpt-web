# 090 — Giảm tải Main Thread UI trong `AiStudioDomObserver` & Smart Auto-Scroll

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Phạm vi:** `ai-studio`, `playwright`, `performance`
- **Ngày:** 2026-11-20

## ⚡ TL;DR
- **Triệu chứng:** Khi mở tab AI Studio trên Launcher trong lúc model đang trả lời ở hội thoại dài (`10,000+` tokens), trang web bị giật/treo khó tương tác; nếu người dùng cuộn lên đầu đoạn chat ngay sau khi gửi thì turn mới bị virtual scroll ẩn khiến tiến trình chờ bị khựng.
- **Nguyên nhân gốc rễ:** `AiStudioDomObserver.captureStatus()` chạy mỗi `250ms–450ms` luôn `cloneNode(true)` + gọi `.innerText` lặp đi lặp lại trên thought/answer/buttons gây CSS Layout Reflow đồng bộ trên Main Thread của trang AI Studio dù `shouldEmitObservationDelta` đang tắt; đồng thời worker chưa cuộn container chat về đáy sau khi bấm Run hoặc khi virtual scroll giấu `.turn-footer`.
- **Cách sửa:** Tách fast-path khi `isGenerating === true` chỉ đọc `textContent.length` (0 reflow, bỏ qua `cloneNode`/Markdown conversion) và ưu tiên `aria-label`/`textContent`; thêm `scrollChatToBottom()` 1 lần sau `submitPrompt` và chỉ cuộn nhắc mỗi 6 nhịp poll (~2.5–3s) khi thiếu answer/footer thay vì cướp thanh cuộn mọi tick.

## Chi tiết thay đổi
- `src/adapters/ai-studio/ai-studio-dom-observer.ts`:
  - Thêm field optional `answerTextLength?: number` vào `AiStudioDomStatus`.
  - Đọc label nút Stop/Cancel & `liveStatus` bằng `aria-label` / `mattooltip` / `textContent`, bỏ `.innerText` gây layout reflow.
  - Khi `isGenerating === true`, trả về lightweight status với `answerTextLength = (targetAnswer.textContent || "").trim().length`, bỏ qua `cloneNode(true)` và parse Markdown trung gian; chỉ full-extract HTML/Markdown khi `!isGenerating`.
- `src/adapters/ai-studio/ai-studio-browser-worker.ts`:
  - Thêm `scrollChatToBottom(page)` tự tìm scroll container của `.chat-session-content` và kéo xuống đáy.
  - Gọi `scrollChatToBottom(page)` 1 lần cuối `submitPrompt()`.
  - Trong `beforeObserveResponse()`, chỉ gọi `scrollChatToBottom(page)` mỗi 6 nhịp poll khi `!hasNewAnswerTurn || !hasContent || (!isGenerating && !hasTurnFooter)`.
- `tests/ai-studio-adapter.test.ts`: Bổ sung unit test xác nhận fast-path `captureStatus` không `cloneNode`/`innerText` khi đang generate và hành vi Smart Auto-Scroll có kiểm soát.
