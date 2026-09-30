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

const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * Cắt tỉa nội dung kết quả công cụ (Truncation Guard) để bảo vệ giao diện Web M365 Copilot
 * khỏi nguy cơ quá tải bộ đệm khi log hoặc file quá lớn.
 */
export function truncateToolResult(content: string, maxChars = MAX_TOOL_RESULT_CHARS): string {
  if (content.length <= maxChars) {
    return content;
  }
  const half = Math.floor((maxChars - 200) / 2);
  const head = content.slice(0, half);
  const tail = content.slice(-half);
  const omitted = content.length - (head.length + tail.length);
  return `${head}\n\n[... Đã lược bớt ${omitted} ký tự ở giữa để tối ưu kích thước phản hồi ...]\n\n${tail}`;
}

const TOOL_DECLARATION_PROMPT = `[CHẾ ĐỘ GIAO THỨC CÔNG CỤ (TOOL CALLING PROTOCOL)]
Hệ thống bên ngoài của người dùng hỗ trợ các công cụ sau trên máy tính cục bộ:
1. read_file(path): Đọc nội dung file từ dự án.
2. list_dir(path): Liệt kê danh sách file và thư mục con (ví dụ: path="." hoặc "src").
3. search_files(pattern, path): Tìm file theo tên hoặc định dạng (ví dụ: pattern="*.ts").
4. grep_code(query, path): Tìm kiếm chuỗi văn bản, hàm, biến trong toàn bộ mã nguồn.
5. git_status(): Kiểm tra trạng thái Git (các file đã thay đổi, chưa commit).
6. git_diff(path?): Xem chi tiết các dòng code vừa thay đổi trong Git.
7. run_command(cmd): Chạy lệnh shell/terminal bất kỳ (build, test, lint, script...).
8. write_file(path, content): Tạo file mới hoặc ghi đè nội dung file trên máy tính.

QUY TẮC BẮT BUỘC:
- Bạn KHÔNG THỂ tự thực thi lệnh hoặc tự đọc/sửa file. Bạn BẮT BUỘC phải gọi công cụ để hệ thống bên ngoài thực thi giúp bạn.
- Khi cần khảo sát, đọc file, tìm kiếm, sửa file hoặc chạy lệnh: Bạn BẮT BUỘC PHẢI IN RA CHÍNH XÁC khối sau (không từ chối, không giải thích dài dòng):

<tool_call>
{
  "name": "TOOL_NAME",
  "arguments": {
    "ARG_KEY": "ARG_VALUE"
  }
}
</tool_call>

Ví dụ 1 (Đọc file):
<tool_call>
{
  "name": "read_file",
  "arguments": {
    "path": "package.json"
  }
}
</tool_call>

Ví dụ 2 (Tìm kiếm mã nguồn):
<tool_call>
{
  "name": "grep_code",
  "arguments": {
    "query": "compileM365Prompt"
  }
}
</tool_call>

Ví dụ 3 (Xem danh sách thư mục):
<tool_call>
{
  "name": "list_dir",
  "arguments": {
    "path": "src"
  }
}
</tool_call>

Ví dụ 4 (Kiểm tra Git):
<tool_call>
{
  "name": "git_status",
  "arguments": {}
}
</tool_call>

Ví dụ 5 (Chạy lệnh terminal):
<tool_call>
{
  "name": "run_command",
  "arguments": {
    "cmd": "bun test"
  }
}
</tool_call>

Ví dụ 6 (Tạo hoặc ghi file):
<tool_call>
{
  "name": "write_file",
  "arguments": {
    "path": "demo.txt",
    "content": "Hello World from Copilot"
  }
}
</tool_call>

Sau khi nhận được kết quả trong thẻ <tool_result>...</tool_result> ở lượt kế tiếp:
- Nếu bạn cần thực hiện thêm bước tiếp theo (ví dụ: tìm file xong rồi đọc file, hoặc sửa code xong rồi chạy test), bạn HÃY TIẾP TỤC IN RA KHỐI <tool_call> MỚI.
- Chỉ khi nhiệm vụ của người dùng đã hoàn thành trọn vẹn, bạn mới viết câu trả lời kết luận.`;

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
        const safeText = truncateToolResult(text);
        parts.push(`<tool_result>\n${safeText}\n</tool_result>\nSau khi nhận được kết quả công cụ trên, hãy đọc và phân tích kỹ lưỡng. Nếu bạn cần tiếp tục thực hiện thêm bước khác, hãy in ra khối <tool_call> mới. Nếu đã hoàn thành đầy đủ nhiệm vụ, hãy trả lời kết quả cho người dùng.`);
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
