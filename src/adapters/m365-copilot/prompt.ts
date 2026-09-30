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

const TOOL_DECLARATION_PROMPT = `[CHẾ ĐỘ GIAO THỨC CÔNG CỤ (TOOL CALLING PROTOCOL)]
Hệ thống bên ngoài của người dùng hỗ trợ công cụ:
- read_file(path): Đọc nội dung file từ máy tính của người dùng.

Bạn không cần và không thể tự thực thi file. Để hệ thống bên ngoài đọc file giúp bạn, khi người dùng yêu cầu đọc, xem, mở, hoặc kiểm tra bất kỳ file nào (ví dụ: "Read pom.xml", "Read package.json", "Đọc file...", v.v.):
Bạn BẮT BUỘC PHẢI IN RA CHÍNH XÁC khối sau, không từ chối, không giải thích, không chạy code:

<tool_call>
{
  "name": "read_file",
  "arguments": {
    "path": "FILE_PATH"
  }
}
</tool_call>

Ví dụ:
Người dùng: Read pom.xml
Bạn in ra:
<tool_call>
{
  "name": "read_file",
  "arguments": {
    "path": "pom.xml"
  }
}
</tool_call>

Ví dụ 2:
Người dùng: Read package.json
Bạn in ra:
<tool_call>
{
  "name": "read_file",
  "arguments": {
    "path": "package.json"
  }
}
</tool_call>

Sau khi nhận được kết quả file trong thẻ <tool_result>...</tool_result> ở lượt kế tiếp, bạn mới đọc nội dung đó và trả lời người dùng.`;

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

  // 1. Thu thập Developer & System Prompts và Tool Instructions
  if (isNewConversation && parsed.context.systemPrompt && parsed.context.systemPrompt.length > 0) {
    const filteredSystem = parsed.context.systemPrompt
      .map(sp => sp.trim())
      .filter(sp => sp.length > 0 && !sp.startsWith("<environment_context>") && !sp.includes("spawn_agent"))
      .join("\n\n");
    if (filteredSystem) {
      parts.push(`[System Instructions]:\n${filteredSystem}`);
    }
  }

  // Luôn inject định nghĩa tool nếu lượt này không phải là nhận toolResult
  const hasToolResultInTurn = messages.some(m => m.role === "toolResult");
  if (!hasToolResultInTurn) {
    parts.push(`[Tool Instructions]:\n${TOOL_DECLARATION_PROMPT}`);
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
        console.log("[M365 TOOL] received tool result");
        parts.push(`<tool_result>\n${text}\n</tool_result>\nSau khi nhận được kết quả tool, hãy đọc nội dung trên và trả lời người dùng.`);
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
