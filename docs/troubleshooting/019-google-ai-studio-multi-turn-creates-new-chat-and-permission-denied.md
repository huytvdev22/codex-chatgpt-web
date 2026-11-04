# [ISSUE-019] Google AI Studio Gửi Tin Nhắn Thứ 2 Mở New Chat Thay Vì Tiếp Tục Hội Thoại Và Bị Permission Denied

> **Status:** ⏳ Chờ User Test & Confirm  
> **Providers:** `google-ai-studio`, `launcher`, `electron`, `playwright`  
> **Keywords:** `multi-turn`, `retain`, `new_chat`, `Permission denied`, `ensureTargetPage`, `reused`

## ⚡ TL;DR (AI Đọc Nhanh 5 Giây)
- **Triệu chứng:** Ở tin nhắn thứ 2 từ Codex, Launcher không chat tiếp trong session hiện tại mà tạo tab mới điều hướng tới `aistudio.google.com/u/0/prompts/new_chat`, gửi prompt vội khi session chưa sẵn sàng dẫn đến lỗi `Permission denied`, lặp lại 3 lần rồi báo lỗi ở Codex.
- **Nguyên nhân gốc rễ:** 
  1. **Thiếu retain tab ở cuối turn 1:** Trong `GoogleAIStudioAdapter`, lệnh `notifyLauncherTurn(phase="end")` không truyền `retain: true` và `connectorBound: true`. Launcher do đó thu hồi (`removeTurnTab`) và đóng tab ngay khi kết thúc turn 1.
  2. **Playground không sinh Prompt ID:** Google AI Studio Playground giữ URL `/prompts/new_chat` mà không đổi sang `/prompts/<id>`, khiến `parseGoogleAIStudioPromptId` trả về null, Launcher không bind được `conversationId` và coi `effectiveConnectorBound` là false.
  3. **Reload trang không cần thiết:** Hàm `ensureTargetPage` trong browser worker kiểm tra `options.promptId` bị thiếu nên ép điều hướng về `new_chat` thay vì giữ nguyên tab đang mở; khi trang mới vừa load xong DOM mà chưa handshake xong quota GCP thì gửi tin nhắn sẽ bị `Permission denied`.
- **Cách sửa:** 
  1. Trong `src/adapters/google-ai-studio/index.ts`: Bổ sung `retain: true`, `connectorBound: true`, `conversationId: finalPromptId || conversationKey` khi gửi `phase="end"`; đồng thời tính `isNewConversation = !launcherConnection?.reused && !hasPriorAssistantReply && !existingPromptId`.
  2. Trong `launcher/electron/browser-host.cjs`: Fallback `tab.conversationId = tab.conversationKey` và đánh dấu `effectiveConnectorBound = true` khi hoàn tất turn `google-ai-studio` để Launcher giữ tab lại cho các lượt sau.
  3. Trong `src/adapters/google-ai-studio/browser-worker.ts`: Trong `ensureTargetPage`, nếu `!options.isNewConversation` và tab đã ở `aistudio.google.com`, giữ nguyên tab hiện tại, tuyệt đối không gọi `page.goto` hoặc reload.

---

## 🛠️ Chi Tiết Triển Khai & Sửa Đổi

### 1. `launcher/electron/browser-host.cjs`
- Trong handler `endTurn`:
  ```javascript
  if (tab.provider === "google-ai-studio" && status === "completed") {
    const liveUrl = typeof tab.view?.webContents?.getURL === "function" ? tab.view.webContents.getURL() : undefined;
    const parsedId = parseGoogleAIStudioPromptId(liveUrl);
    const rawId = conversationId || parsedId || tab.conversationId || tab.conversationKey;
    const normalizedConversationId = normalizeGoogleAIStudioPromptId(rawId) || tab.conversationKey;
    if (tab.conversationKey && this.googleAIStudioSurfaceManager) {
      tab.conversationId = normalizedConversationId;
      if (parsedId) {
        try { this.googleAIStudioSurfaceManager.bind(tab.conversationKey, parsedId); } catch {}
      }
      effectiveConnectorBound = true;
    }
  }
  ```
- Tab của Google AI Studio được retain thành công vào `turnTabs` và được tái sử dụng nguyên vẹn (`reused: true`) ở các lượt kế tiếp có cùng `conversationKey`.

### 2. `launcher/electron/google-ai-studio-surface-manager.cjs`
- Hàm `initialUrl(conversationKey)`: Chỉ trả về URL chứa promptId nếu URL đó thực sự hợp lệ, tránh sinh ra URL rác `prompts/<hash>`.

### 3. `src/adapters/google-ai-studio/index.ts`
- Cập nhật logic nhận diện `isNewConversation`:
  `const isNewConversation = !launcherConnection?.reused && !hasPriorAssistantReply && !existingPromptId;`
- Gửi đầy đủ `retain: true`, `connectorBound: true` và `conversationId: finalPromptId || conversationKey` trong `notifyLauncherTurn(phase="end")`.

### 4. `src/adapters/google-ai-studio/browser-worker.ts`
- Trong `ensureTargetPage`:
  Nếu `!options.isNewConversation` và tab đã ở `aistudio.google.com`:
  Log `[ai-studio-worker] Giữ nguyên tab hiện tại cho multi-turn` và return ngay lập tức mà không reload hay chuyển hướng.
- Trong `pageError`: Giới hạn kiểm tra lỗi `Permission denied` chỉ trong các turn mới `ms-chat-turn:not([data-codex-turn-baseline])`.
