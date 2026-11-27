import type { CodexJsonSchemaOutputFormat } from "../types";

/**
 * Giao thức Hybrid (Natural-First cho Final Answer + 4-backtick Transport Fence cho Action Turn):
 * - Trả lời thông thường: viết trực tiếp Markdown tự nhiên (streaming tức thì lên Telegram).
 * - Thao tác trên máy Mac / gọi MCP / apply_patch: BẮT BUỘC bọc trong 1 khối 4-backtick ````markdown ... ````
 *   để Web UI giữ trong `<pre><code>`, không làm nát thụt lề/HTML của `apply_patch` và JSON tool call.
 * - Cho phép dùng Web Search tích hợp khi tra cứu tin tức/kiến thức trực tuyến.
 */
export function buildAssistantProtocol(assistantName = "trợ lý"): string {
  return `Chào ${assistantName}, bạn đang làm Trợ lý AI Cá nhân cục bộ trên máy Mac (giao tiếp qua Telegram):
1. Trả lời bình thường (hỏi đáp, tóm tắt, tư vấn): viết **trực tiếp bằng Markdown tự nhiên**, ngắn gọn dễ đọc trên điện thoại (KHÔNG bọc 4-backtick hay \`<webResponse>\`). Có thể dùng Web Search tích hợp để tra tin tức/thông tin trực tuyến.
2. Khi cần đọc/sửa tệp, chạy lệnh trên máy Mac hoặc gọi MCP trong \`[TOOL CATALOG]\`: KHÔNG từ chối vì "không có công cụ" — hãy bọc toàn bộ lời gọi trong DUY NHẤT 1 khối 4-backtick (\`\`\`\`markdown ... \`\`\`\`) để giữ nguyên 100% thụt lề/ký tự và không viết chữ ngoài khối:
   • Function tool (có thể gọi nhiều thẻ song song khi chỉ đọc/kiểm tra):
     \`\`\`\`markdown
     <tool_call>{"name":"<TÊN_TOOL>","arguments":{"<THAM_SỐ>":"<GIÁ_TRỊ>"}}</tool_call>
     \`\`\`\`
   • Tạo/sửa tệp (mỗi lượt 1 tệp bằng \`apply_patch\`, file mới dùng \`*** Add File:\` kèm dấu \`+\` mỗi dòng, giữ chính xác 100% thụt lề):
     \`\`\`\`markdown
     <custom_tool_call name="apply_patch">
     *** Begin Patch
     *** Update File: path/to/file.ext
     @@ context @@
      giữ nguyên
     -xóa
     +thêm
     *** End Patch
     </custom_tool_call>
     \`\`\`\``;
}

export const ASSISTANT_TOOL_RESULT_HEADER =
  "Kết quả công cụ nằm trong `<tool_result>` bên dưới (exit code `0` hoặc trống = thành công). Cần bước tiếp thì xuất `<tool_call>` / `<custom_tool_call name=\"apply_patch\">` bọc trong 4-backtick ````markdown ... ````, xong thì trả lời trực tiếp bằng Markdown tự nhiên.";

export const ASSISTANT_TOOL_ERROR_HEADER =
  "Công cụ vừa chạy bị lỗi trong `<tool_result>` bên dưới. Hãy xem lỗi rồi đổi lệnh/tham số khác bọc trong 4-backtick ````markdown ... ```` (không lặp lại y hệt lệnh vừa lỗi) hoặc giải thích ngắn gọn cho người dùng.";

export const ASSISTANT_USER_INPUT_HEADER =
  "[Phản hồi người dùng vừa chọn/nhập qua Telegram]:";

export const ASSISTANT_IMAGE_ATTACHMENT_HINT =
  "[Ảnh đính kèm]: Hãy quan sát trực tiếp hình ảnh đính kèm để trả lời.";

export function buildAssistantStructuredJsonProtocol(options: {
  schemaName: string;
  strict: boolean;
  schema: unknown;
}): string {
  return `Xuất DUY NHẤT 1 đối tượng JSON hợp lệ khớp JSON Schema "${options.schemaName}" (strict=${options.strict}), không kèm lời giải thích hay thẻ XML:
\`\`\`json
${JSON.stringify(options.schema)}
\`\`\``;
}

export function buildAssistantFormatRetryPrompt(options: {
  code: string;
  message: string;
  schemaHint?: string;
  outputFormat?: CodexJsonSchemaOutputFormat;
}): string {
  if (options.code === "INVALID_JSON_SCHEMA_OUTPUT" && options.outputFormat) {
    return `JSON vừa rồi chưa khớp schema "${options.outputFormat.name}" (${options.message}). Hãy trả về DUY NHẤT 1 JSON hợp lệ theo schema:\n\`\`\`json\n${JSON.stringify(options.outputFormat.schema)}\n\`\`\``;
  }

  const hintPart = options.schemaHint ? `\n\n${options.schemaHint}` : "";
  return `Lời gọi công cụ vừa rồi chưa thực thi được do lỗi [${options.code}]: ${options.message}${hintPart}\n\nHãy xuất lại đúng cú pháp bọc trong 4-backtick \`\`\`\`markdown ... \`\`\`\` chứa \`<tool_call>{"name":"...","arguments":{...}}</tool_call>\` (hoặc \`<custom_tool_call name="apply_patch">...\`), hoặc trả lời trực tiếp bằng Markdown tự nhiên.`;
}

export function buildAssistantRepeatedFailedToolPrompt(options: {
  toolName: string;
  errorSnippet?: string;
}): string {
  const errLine = options.errorSnippet
    ? `\nLỗi trước: \`${options.errorSnippet.replace(/\s+/g, " ").slice(0, 260)}\``
    : "";
  return `Bạn vừa lặp lại công cụ \`${options.toolName}\` với đúng tham số vừa thất bại.${errLine}\nHãy đổi cách kiểm tra/tham số khác (nếu là \`apply_patch\` hãy đọc lại file trước) hoặc báo ngắn gọn nguyên nhân bằng Markdown tự nhiên.`;
}
