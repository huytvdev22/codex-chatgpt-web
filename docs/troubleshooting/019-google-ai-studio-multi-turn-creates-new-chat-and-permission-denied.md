# [ISSUE-019] Google AI Studio Gửi Tin Nhắn Thứ 2 Mở New Chat Hoặc Bị Lỗi Permission Denied Do Retry Prompt Độc Hại

> **Status:** ⏳ Chờ User Test & Confirm  
> **Providers:** `google-ai-studio`, `launcher`, `electron`, `playwright`, `m365-copilot-protocol`  
> **Keywords:** `multi-turn`, `retain`, `new_chat`, `Permission denied`, `ensureTargetPage`, `Tolerant Answers`, `reused`

## ⚡ TL;DR (AI Đọc Nhanh 5 Giây)
- **Triệu chứng:** Ở tin nhắn thứ 2 từ Codex, Launcher không chat tiếp trong session hiện tại mà tạo tab mới điều hướng tới `new_chat`; hoặc ở tin nhắn đầu tiên khi model trả lời Markdown tự nhiên, adapter gửi một Retry Prompt dài lê thê và giao diện AI Studio lập tức ném banner lỗi `Failed to generate content: permission denied. Please try again.`.
- **Nguyên nhân gốc rễ:** 
  1. **Thiếu retain tab ở cuối turn 1:** `notifyLauncherTurn(phase="end")` trước đó thiếu `retain: true` và `connectorBound: true`, làm tab bị đóng ngay khi hết lượt 1.
  2. **Playground không đổi URL:** AI Studio Playground giữ nguyên `/prompts/new_chat`, `parseGoogleAIStudioPromptId` trả về null khiến `effectiveConnectorBound` bị coi là false.
  3. **Không dọn sạch trang cũ khi mở hội thoại mới:** `ensureTargetPage` thấy URL đã là `new_chat` thì không reload, giữ nguyên các turn cũ và thông báo lỗi cũ của phiên trước.
  4. **Strict Parser quá khắt khe kích hoạt Retry Prompt độc hại:** Khi Gemini trả lời văn bản Markdown tự nhiên (không bọc trong 4-backtick ````markdown```` hoặc `<webResponse>`), parser ném lỗi `MISSING_TRANSPORT_FENCE`. Adapter gửi `buildM365FormatRetryPrompt` dài chứa đầy thẻ XML `<tool_call>`, `<webResponse>` khiến bộ lọc an toàn của AI Studio kích hoạt lỗi `Failed to generate content: permission denied`.
- **Cách sửa:** 
  1. Trong `src/adapters/google-ai-studio/index.ts`: Bổ sung cơ chế **Tolerant Answers**: chấp nhận câu trả lời văn bản tự nhiên khi không chứa bất kỳ hành vi gọi công cụ nào (`!hasActionMarkers`), triệt tiêu hoàn toàn Retry Prompt độc hại; gửi `retain: true`, `connectorBound: true` để giữ tab cho multi-turn.
  2. Trong `launcher/electron/browser-host.cjs`: Fallback `tab.conversationId = tab.conversationKey` và đánh dấu `effectiveConnectorBound = true` khi hoàn tất turn `google-ai-studio`.
  3. Trong `src/adapters/google-ai-studio/browser-worker.ts`: Trong `ensureTargetPage`, nếu là `isNewConversation === true` và trang đang có turn cũ, tự động reload về `GOOGLE_AI_STUDIO_NEW_CHAT_URL` sạch sẽ và đóng các banner lỗi cũ; nếu là multi-turn tiếp nối thì giữ nguyên tab hiện tại.

---

## 🛠️ Chi Tiết Triển Khai & Sửa Đổi

### 1. `src/adapters/google-ai-studio/index.ts`
- **Áp dụng Tolerant Answers:**
  ```typescript
  protocolResult = parseStrictM365Response(lastRaw);
  if (protocolResult.kind === "protocol_error") {
    const isWrapperError =
      protocolResult.code === "MISSING_TRANSPORT_FENCE" ||
      protocolResult.code === "MISSING_RESPONSE_ENVELOPE";
    const hasActionMarkers =
      lastRaw.includes("<tool_call>") ||
      lastRaw.includes("<custom_tool_call") ||
      lastRaw.includes("*** Begin Patch");

    if (isWrapperError && !hasActionMarkers && lastRaw.trim().length > 0) {
      protocolResult = {
        kind: "final_answer",
        content: lastRaw.replace(/<\/?webResponse>/gi, "").trim(),
        rawResponse: lastRaw,
      };
    }
  }
  ```
- **Retain Tab:** Gửi `retain: true`, `connectorBound: true`, `conversationId: finalPromptId || conversationKey` trong `notifyLauncherTurn(phase="end")`.

### 2. `src/adapters/google-ai-studio/browser-worker.ts`
- **Làm sạch trang khi tạo hội thoại mới:**
  ```typescript
  const hasOldTurns = await page.evaluate(() => {
    return document.querySelectorAll("ms-chat-turn").length > 0;
  }).catch(() => false);

  if (!currentUrl.includes("aistudio.google.com") || hasOldTurns || currentPromptId) {
    await page.goto(GOOGLE_AI_STUDIO_NEW_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2000);
  }
  ```
- **Giữ nguyên tab khi chat tiếp nối (multi-turn):** Nếu `!options.isNewConversation` và tab đã ở `aistudio.google.com`, không reload hay chuyển hướng.

### 3. `launcher/electron/browser-host.cjs`
- Fallback `tab.conversationId = tab.conversationKey` và `effectiveConnectorBound = true` khi hoàn tất turn `google-ai-studio`.
