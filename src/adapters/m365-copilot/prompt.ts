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
Hệ thống môi trường hỗ trợ các công cụ sau để thao tác trực tiếp với dự án:
1. git_status(): Kiểm tra trạng thái Git (các file đã thay đổi, file mới tạo, nhánh hiện tại).
2. git_diff(path?): Xem chi tiết các dòng code vừa thay đổi trong Git.
3. read_file(path): Đọc nội dung file từ dự án.
4. list_dir(path): Liệt kê danh sách file và thư mục (ví dụ: path="." hoặc "src").
5. search_files(pattern, path?): Tìm file theo tên hoặc định dạng (ví dụ: pattern="*.ts").
6. grep_code(query, path?): Tìm kiếm chuỗi văn bản, hàm, biến trong mã nguồn.
7. run_command(cmd): Chạy lệnh shell/terminal bất kỳ (build, test, lint, script...).
8. write_file(path, content): Tạo file mới hoặc ghi đè nội dung file.

QUY TẮC ĐỊNH DẠNG ĐẦU RA:
- Khi người dùng yêu cầu thao tác với dự án (tạo file, sửa code, đọc file, chạy lệnh, kiểm tra git), bạn PHẢI phản hồi bằng định dạng JSON trong khối <tool_call>...</tool_call>:
<tool_call>
{
  "name": "TOOL_NAME",
  "arguments": {
    "ARG_KEY": "ARG_VALUE"
  }
}
</tool_call>
- Không viết code dưới dạng block markdown giải thích thủ công khi người dùng yêu cầu tạo hoặc sửa file; hãy sử dụng công cụ write_file để tạo/ghi file vào dự án.
- Luôn in khối <tool_call> ở đầu câu trả lời, không chèn câu chào hỏi hay lời dẫn dắt trước khối này.

QUY TẮC YÊU CẦU ĐA BƯỚC (MULTI-STEP):
- Khi yêu cầu gồm một chuỗi nhiều bước (ví dụ: kiểm tra cú pháp sau đó chạy server rồi test), hãy xuất <tool_call> cho bước đầu tiên trước (ví dụ: dùng run_command với "node --check <file>").
- Sau khi nhận được kết quả trong thẻ <tool_result> ở lượt tiếp theo, bạn sẽ tiếp tục xuất <tool_call> cho bước kế tiếp cho đến khi hoàn thành toàn bộ nhiệm vụ.

CÁC VÍ DỤ MẪU CHUẨN:

Ví dụ 1 (Kiểm tra Git status):
Người dùng: Cho tôi xem git status hiện tại của dự án
Bạn in ra:
<tool_call>
{
  "name": "git_status",
  "arguments": {}
}
</tool_call>

Ví dụ 2 (Đọc file):
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

Ví dụ 3 (Xem Git diff):
Người dùng: Cho tôi xem diff của package.json
Bạn in ra:
<tool_call>
{
  "name": "git_diff",
  "arguments": {
    "path": "package.json"
  }
}
</tool_call>

Ví dụ 4 (Xem thư mục):
Người dùng: Liệt kê các file trong thư mục src
Bạn in ra:
<tool_call>
{
  "name": "list_dir",
  "arguments": {
    "path": "src"
  }
}
</tool_call>

Ví dụ 5 (Tìm kiếm file hoặc code):
Người dùng: Tìm xem hàm compileM365Prompt nằm ở đâu
Bạn in ra:
<tool_call>
{
  "name": "grep_code",
  "arguments": {
    "query": "compileM365Prompt"
  }
}
</tool_call>

Ví dụ 6 (Chạy lệnh terminal):
Người dùng: Chạy thử bài kiểm tra test
Bạn in ra:
<tool_call>
{
  "name": "run_command",
  "arguments": {
    "cmd": "bun test"
  }
}
</tool_call>

Ví dụ 7 (Tạo hoặc sửa file):
Người dùng: tạo 1 server đơn giản bằng node js vào project hiện tại
Bạn in ra:
<tool_call>
{
  "name": "write_file",
  "arguments": {
    "path": "server.js",
    "content": "const http = require('http');\\nconst PORT = process.env.PORT || 3000;\\nconst server = http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ message: 'Hello' })); });\\nserver.listen(PORT);"
  }
}
</tool_call>

Ví dụ 8 (Yêu cầu đa bước - Kiểm tra và chạy thử):
Người dùng: kiểm tra cú pháp file server.js sau đó run server lên rồi test cho tôi
Bạn in ra (thực hiện bước 1 kiểm tra cú pháp trước):
<tool_call>
{
  "name": "run_command",
  "arguments": {
    "cmd": "node --check server.js"
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

  // Nếu lượt này là yêu cầu của người dùng (không phải nhận toolResult),
  // bổ sung chỉ dẫn định dạng ở cuối để định hướng mô hình xuất khối <tool_call> thay vì viết code tĩnh
  if (!hasToolResultInTurn && parts.length > 0) {
    parts.push(`[Yêu cầu định dạng đầu ra]: Hãy sử dụng khối <tool_call> tương ứng (bước 1 nếu có nhiều bước) để thực thi yêu cầu trên của người dùng thay vì chỉ viết hướng dẫn văn bản.`);
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
