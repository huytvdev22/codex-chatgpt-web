# [ISSUE-001] Mỗi Tin Nhắn Trên Codex Tạo Ra 1 Đoạn Chat Mới Trên Web

> **Status:** ✅ RESOLVED & CONFIRMED BY USER (18/10/2026)  
> **Providers:** `qwen-web`, `chatgpt-web`  
> **Keywords:** `isNewConversation`, `conversationId`, `retain`, `multi-turn`, `new chat`, `threadId`

## ⚡ TL;DR (AI Đọc Nhanh 5 Giây)
- **Triệu chứng:** Mỗi câu hỏi gửi từ Codex (turn 1, turn 2...) tạo thêm 1 thread mới trên giao diện web (`chat.qwen.ai` hoặc `chatgpt.com`) thay vì chat tiếp trong thread cũ.
- **Nguyên nhân:** Biến `isNewConversation` bị tính là `true` khi `messages` không chứa text assistant (title turn / format phụ), làm xóa sạch `existingConversationId = undefined`, khiến worker gọi `page.goto('/')` mở chat mới. Ngoài ra worker thiếu polling chờ URL SPA đổi sang `/c/<id>` nên không lưu được ID vào store và Launcher đóng tab.
- **Giải pháp:** 
  1. `isNewConversation = !hasPriorAssistantReply && !existingConversationId` (nếu đã có ID trong store/lease thì KHÔNG BAO GIỜ là new conversation).
  2. Worker: Polling 3s chờ URL `/c/<id>`, fallback đọc sidebar DOM, và nếu tab đang ở `/c/` thì giữ nguyên tab, không `goto('/')`.
  3. Launcher: Fallback `rawId = conversationId || parseUrl || tab.conversationId` khi `endTurn` để retain tab.

## 🛠️ File Sửa & Quy Tắc Cốt Lõi
- `src/adapters/qwen-web/index.ts` & `src/adapters/chatgpt-web/index.ts`:
  ```typescript
  const storedConvId = defaultStore.getConversationId(threadId);
  const rawExistingConvId = leaseConversationId || storedConvId;
  const existingConversationId = isValidConvId(rawExistingConvId) ? rawExistingConvId : undefined;
  const isNewConversation = !hasPriorAssistantReply && !existingConversationId;
  ```
- `src/adapters/qwen-web/qwen-browser-worker.ts`:
  - Trong loop & sau loop: Polling URL chứa `/c/<id>`, fallback DOM `nav a[href*="/c/"]`.
  - Trong navigation: Nếu `!isNewConversation` và tab đã ở `/c/`, giữ nguyên tab.
- `launcher/electron/browser-host.cjs`:
  - Trong `endTurn`: Giữ `tab.conversationId` để đảm bảo `effectiveConnectorBound = true` và `retain = true`.
