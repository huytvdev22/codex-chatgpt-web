import type { CodexContentPart, CodexParsedRequest } from "../../types";

const MAX_M365_PROMPT_CHARS = 95_000;

function stringifyContent(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part.type === "text") return part.text;
        if (part.type === "image") return `[Image: ${part.imageUrl.slice(0, 50)}...]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Biên dịch CodexParsedRequest thành prompt tối ưu cho Microsoft 365 Copilot
 * @param isNewConversation true nếu là cuộc trò chuyện mới hoặc cần ngữ cảnh đầy đủ; false nếu đang tiếp tục cuộc trò chuyện hiện tại
 */
export function compileM365Prompt(parsed: CodexParsedRequest, isNewConversation = true): string {
  const parts: string[] = [];

  const allMessages = parsed.context.messages || [];
  let messages = allMessages;

  if (!isNewConversation) {
    const lastAssistantIdx = allMessages.findLastIndex(msg => msg.role === "assistant");
    if (lastAssistantIdx >= 0 && lastAssistantIdx < allMessages.length - 1) {
      messages = allMessages.slice(lastAssistantIdx + 1);
    }
  }

  // 1. Thu thập Developer & System Prompts (chỉ gửi đầy đủ khi là New Conversation)
  if (isNewConversation && parsed.context.systemPrompt && parsed.context.systemPrompt.length > 0) {
    const filteredSystem = parsed.context.systemPrompt
      .map(sp => sp.trim())
      .filter(sp => sp.length > 0 && !sp.startsWith("<environment_context>") && !sp.includes("spawn_agent"))
      .join("\n\n");
    if (filteredSystem) {
      parts.push(`[System Instructions]:\n${filteredSystem}`);
    }
  }

  // 2. Thu thập Messages theo thứ tự thời gian
  for (const msg of messages) {
    if (msg.role === "developer") {
      const text = stringifyContent(msg.content);
      if (text.length > 0 && text.length < 2000) {
        parts.push(`[Context]: ${text}`);
      }
    } else if (msg.role === "user") {
      const text = stringifyContent(msg.content);
      if (text) {
        parts.push(text);
      }
    } else if (msg.role === "assistant") {
      const texts: string[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          texts.push(part.text);
        }
      }
      if (texts.length > 0) {
        parts.push(`[Trợ lý]: ${texts.join("\n")}`);
      }
    } else if (msg.role === "toolResult") {
      const text = stringifyContent(msg.content);
      if (text) {
        parts.push(`[Kết quả công cụ ${msg.toolName}]:\n${text}`);
      }
    }
  }

  let finalPrompt = parts.join("\n\n").trim();

  // 3. Cắt tỉa nếu vượt quá ngưỡng an toàn của M365 (95,000 ký tự)
  if (finalPrompt.length > MAX_M365_PROMPT_CHARS) {
    // Giữ lại phần đầu (hướng dẫn) và phần đuôi (câu hỏi/ngữ cảnh gần nhất)
    const headLimit = 15_000;
    const tailLimit = MAX_M365_PROMPT_CHARS - headLimit - 200;
    const head = finalPrompt.slice(0, headLimit);
    const tail = finalPrompt.slice(-tailLimit);
    finalPrompt = `${head}\n\n... [Một số ngữ cảnh cũ được rút gọn để tối ưu độ dài cho M365 Copilot] ...\n\n${tail}`;
  }

  return finalPrompt;
}
