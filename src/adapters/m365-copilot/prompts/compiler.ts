import { logFunctionInput } from "../debug-logger";
import type { CodexParsedRequest } from "../../../types";
import type { NormalizedCodexRequest, NormalizedTool } from "../normalization/canonical-types";
import {
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  TOOL_REMINDER_PROMPT,
} from "./templates";
import {
  MANDATORY_4_BACKTICK_MARKDOWN_PROMPT,
  MANDATORY_4_BACKTICK_PLAN_MODE_PROMPT,
} from "../temp-chat/prompts";

const MAX_M365_PROMPT_CHARS = 95_000;
const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * Thực hiện xử lý truncateToolResult cho quy trình M365 Copilot Adapter.
 */
export function truncateToolResult(content: string, maxChars = MAX_TOOL_RESULT_CHARS): string {
  logFunctionInput("prompts:compiler", "truncateToolResult", { content, maxChars });
  if (content.length <= maxChars) return content;
  const half = Math.floor((maxChars - 200) / 2);
  const head = content.slice(0, half);
  const tail = content.slice(-half);
  const omitted = content.length - (head.length + tail.length);
  return `${head}\n\n[... Đã lược bớt ${omitted} ký tự ở giữa để tối ưu kích thước phản hồi ...]\n\n${tail}`;
}

/**
 * Giao thức giao tiếp thống nhất với IDE (Text Interaction Protocol).
 * Thống nhất format gọi tool DUY NHẤT:
 * 1. Function tool: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 * 2. Custom tool: <custom_tool_call name="apply_patch">*** Begin Patch ... *** End Patch</custom_tool_call>
 * Rút gọn toàn bộ sandbox/permissions và loại bỏ các ví dụ dài dòng gây áp đảo ngữ cảnh.
 */
export const UNIFIED_TOOL_PROTOCOL = `[HỆ THỐNG GIAO TIẾP VĂN BẢN VỚI IDE - GIAO THỨC XML RESPONSE ENVELOPE]
Bạn là Trợ lý Lập trình viên AI hỗ trợ phát triển dự án của người dùng.
Hệ thống IDE trên máy tính người dùng tự động bắt lấy văn bản bạn in ra, chạy trực tiếp trên dự án cục bộ và trả kết quả vào thẻ <tool_result> cho bạn ở lượt kế tiếp.

QUY TẮC ĐỊNH DẠNG ĐẦU RA BẮT BUỘC (MỌI CÂU TRẢ LỜI ĐỀU BỌC TRONG <m365Response>):
Mọi phản hồi của bạn BẮT BUỘC phải đặt trong cặp thẻ root <m365Response>...</m365Response> theo cấu trúc 3 phần chuẩn sau:

<m365Response>
<thought>
[Suy luận nội tâm: Phân tích mục tiêu, nhận định tình trạng mã nguồn, lập kế hoạch hành động hoặc hướng giải quyết]
</thought>
[Phần văn bản Markdown tự nhiên gửi cho người dùng: Lời dẫn dắt ngắn gọn nếu sắp gọi công cụ, HOẶC câu trả lời/giải thích hoàn chỉnh nếu là kết luận cuối cùng]

<tool_call>
{"name": "<TOOL_NAME>", "arguments": {"<PARAM_NAME>": "<VALUE>"}}
</tool_call>
</m365Response>

QUY TẮC PHÂN ĐỊNH ỨNG XỬ:
1. KHI NGƯỜI DÙNG CHÀO HỎI, HỎI ĐÁP KIẾN THỨC, GIẢI THÍCH CODE HOẶC KẾT LUẬN CUỐI CÙNG:
   - Viết suy nghĩ trong thẻ <thought>...</thought>.
   - Viết câu trả lời đầy đủ, thân thiện bằng văn bản Markdown ở phần text giữa.
   - TUYỆT ĐỐI KHÔNG xuất thẻ <tool_call> trong lượt này.
   Ví dụ mẫu:
   <m365Response>
   <thought>Người dùng chào hỏi, tôi sẽ chào lại thân thiện và sẵn sàng hỗ trợ dự án.</thought>
   Xin chào anh Huy! 👋 Mình có thể hỗ trợ anh viết code, sửa lỗi hoặc phát triển dự án. Hôm nay anh cần làm gì?
   </m365Response>

2. KHI CẦN THAO TÁC TRÊN DỰ ÁN (CHẠY LỆNH, ĐỌC FILE, XEM THƯ MỤC):
   - Nêu suy luận trong thẻ <thought>...</thought>.
   - Kèm 1 câu dẫn dắt mô tả hành động sắp làm.
   - Xuất khối <tool_call> chứa JSON tham số tương ứng.

3. ĐẶC BIỆT KHI CHỈNH SỬA HOẶC TẠO FILE (BẮT BUỘC LUÔN DÙNG apply_patch THAY VÌ write_file):
   BẮT BUỘC sử dụng khối Freeform chuẩn dưới đây (TUYỆT ĐỐI KHÔNG bọc trong JSON, KHÔNG dùng write_file):
   a) Khi chỉnh sửa file đã có (Update File):
   <m365Response>
   <thought>
   [Suy luận nội tâm: phân tích nguyên nhân lỗi và phương án sửa chữa mã nguồn]
   </thought>
   [Một câu dẫn dắt mô tả việc chỉnh sửa file]
   <custom_tool_call name="apply_patch">
   *** Begin Patch
   *** Update File: path/to/file.ext
   @@ context_anchor @@
    dòng giữ nguyên
   -dòng xóa
   +dòng thêm
   *** End Patch
   </custom_tool_call>
   </m365Response>

   b) Khi tạo file mới hoàn toàn (Add File):
   <m365Response>
   <thought>
   [Suy luận nội tâm: mô tả file cần tạo mới]
   </thought>
   [Một câu dẫn dắt mô tả việc tạo file mới]
   <custom_tool_call name="apply_patch">
   *** Begin Patch
   *** Add File: path/to/file.ext
   +nội dung dòng 1
   +nội dung dòng 2
   *** End Patch
   </custom_tool_call>
   </m365Response>

QUY TẮC QUAN TRỌNG VỀ THAO TÁC FILE VÀ TERMINAL:
- TẠO FILE MỚI HOẶC SỬA FILE: Ưu tiên sử dụng tuyệt đối <custom_tool_call name="apply_patch"> cho cả tạo file mới (*** Add File:) lẫn sửa file (*** Update File:). BẮT BUỘC luôn dùng apply_patch thay vì write_file. TUYỆT ĐỐI KHÔNG sử dụng write_file.
- NGUYÊN TẮC ĐỘC LẬP TỪNG FILE (SINGLE FILE PER TURN): Mỗi lượt CHỈ ĐƯỢC tạo hoặc sửa ĐÚNG 1 FILE DUY NHẤT. TUYỆT ĐỐI KHÔNG gộp việc ghi/sửa nhiều file trong cùng 1 khối patch và không gọi nhiều patch cùng lúc. Hãy thao tác tuần tự từng file (sửa file 1 -> chờ IDE xác nhận -> sửa file 2).
- ĐỌC FILE AN TOÀN (SAFE READING):
  + Sử dụng read_file với tham số path là 1 tệp tin duy nhất (TUYỆT ĐỐI KHÔNG truyền mảng paths). Mỗi lần chỉ đọc tối đa 1-3 tệp (tổng số dòng <= 150 dòng).
  + Khi đọc tệp dài, bắt buộc chỉ định tham số {"start_line": ..., "end_line": ...} (phạm vi tối đa 150 dòng).
  + NGHIÊM CẤM dùng script shell lặp duyệt mảng đọc tệp (foreach... Get-Content, for... cat) trong exec_command.
  + NGHIÊM CẤM quét toàn bộ cây thư mục đệ quy (tree /F, Get-ChildItem -Recurse, ls -R). Hãy dùng list_dir (depth=1) hoặc search_files / grep_code.
- NGHIÊM CẤM TUYỆT ĐỐI: Không được dùng các lệnh shell (cat <<EOF, cat >, echo >, python, perl, heredoc) để tạo file hoặc ghi đè nội dung file trong exec_command.
- PHẠM VI CỦA exec_command: Chỉ dùng để chạy các câu lệnh dòng lệnh không tương tác (như: npm install, npm test, git status, git diff, mkdir -p ..., node server.js).
- Tuyệt đối không tự chế tên công cụ hoặc dùng các tên alias không có trong danh sách AVAILABLE TOOLS dưới đây.`;

// Alias để tương thích ngược cho các module đang import MINIMAL_TOOL_PROTOCOL
export const MINIMAL_TOOL_PROTOCOL = UNIFIED_TOOL_PROTOCOL;

/**
 * Danh mục chuẩn các công cụ lập trình cốt lõi (Core Coding Tools) do ToolBridge hỗ trợ.
 * Khai báo đầy đủ tên công cụ, mô tả chi tiết, schema tham số và ràng buộc an toàn,
 * đảm bảo M365 Copilot luôn nắm rõ cú pháp và không phải suy đoán tham số.
 */
export const CORE_CODING_TOOLS_DECLARATION = `- read_file
  Đọc nội dung tệp mã nguồn từ dự án cục bộ (tối đa 1-3 tệp mỗi lượt, tổng số dòng <= 150 dòng).
  Tham số:
  + path (string, BẮT BUỘC): Đường dẫn đến 1 tệp tin duy nhất (tuyệt đối hoặc tương đối). TUYỆT ĐỐI KHÔNG truyền mảng "paths", chỉ truyền 1 chuỗi đường dẫn.
  + start_line (number, tùy chọn, mặc định 1): Dòng bắt đầu đọc (1-indexed).
  + end_line (number, tùy chọn): Dòng kết thúc đọc (phạm vi: end_line - start_line + 1 <= 150).

- list_dir
  Xem danh sách tệp và thư mục con ở cấp thư mục hiện tại (depth=1, không quét đệ quy).
  Tham số:
  + path (string, tùy chọn, mặc định "."): Đường dẫn thư mục cần xem danh sách.

- search_files
  Tìm kiếm tệp theo mẫu tên (glob pattern) trong thư mục dự án.
  Tham số:
  + pattern (string, BẮT BUỘC): Mẫu tên tệp cần tìm kiếm (ví dụ: "*.js", "*.html", "src/*.ts").
  + path (string, tùy chọn, mặc định "."): Đường dẫn thư mục bắt đầu tìm kiếm.

- grep_code
  Tìm kiếm từ khóa văn bản hoặc biểu thức regex trong nội dung các tệp mã nguồn của dự án.
  Tham số:
  + query (string, BẮT BUỘC): Từ khóa văn bản hoặc biểu thức cần tìm trong code.
  + path (string, tùy chọn, mặc định "."): Thư mục tìm kiếm (mặc định toàn bộ dự án).

- git_status
  Xem nhanh trạng thái thay đổi Git của dự án (các tệp đã sửa, thêm mới, unstaged/staged).
  Tham số:
  Không có tham số (truyền đối số rỗng {}).

- git_diff
  Xem thay đổi chi tiết dạng unified diff của Git.
  Tham số:
  + path (string, tùy chọn): Đường dẫn tệp cụ thể cần xem diff (nếu bỏ trống sẽ diff toàn bộ dự án).

- exec_command
  Thực thi câu lệnh dòng lệnh/CLI không tương tác trong terminal của dự án (như: npm test, npm install, node server.js, mkdir -p ...).
  Tham số:
  + command (string, BẮT BUỘC): Câu lệnh CLI cần chạy.
  Lưu ý an toàn: TUYỆT ĐỐI KHÔNG dùng để tạo/sửa file hoặc script duyệt mảng đọc file (foreach Get-Content).

- apply_patch
  Tạo file mới hoặc chỉnh sửa file đã có trong dự án (ƯU TIÊN TUYỆT ĐỐI CHO MỌI THAO TÁC FILE).
  ĐỊNH DẠNG ĐẶC BIỆT: Đây là công cụ FREEFORM, BẮT BUỘC dùng khối <custom_tool_call name="apply_patch">*** Begin Patch ... *** End Patch</custom_tool_call> (TUYỆT ĐỐI KHÔNG bọc trong JSON, KHÔNG dùng write_file).
  Quy tắc: Mỗi lượt CHỈ ĐƯỢC tạo hoặc sửa ĐÚNG 1 FILE DUY NHẤT.

- write_file
  Tạo file mới hoặc ghi đè nội dung file.
  Tham số:
  + path (string, BẮT BUỘC): Đường dẫn tệp tin cần tạo hoặc ghi đè.
  + content (string, BẮT BUỘC): Nội dung tệp tin.
  LƯU Ý: Khuyến nghị luôn dùng apply_patch thay vì write_file.`;

const CORE_TOOL_NAMES = new Set([
  "read_file",
  "readfile",
  "list_dir",
  "listdir",
  "search_files",
  "searchfiles",
  "grep_code",
  "grepcode",
  "git_status",
  "gitstatus",
  "git_diff",
  "gitdiff",
  "exec_command",
  "execcommand",
  "apply_patch",
  "applypatch",
  "write_file",
  "writefile",
  "run_command",
]);

/**
 * Rút gọn mô tả công cụ thông minh, loại bỏ các tài liệu dông dài của OpenAI và control tokens rác.
 */
export function cleanToolDescription(name: string, rawDesc?: string): string {
  logFunctionInput("prompts:compiler", "cleanToolDescription", { name, rawDesc });
  if (!rawDesc) return "No description provided.";
  let desc = rawDesc.trim();

  // Khử các token placeholder rác dạng ¨C...C
  desc = desc.replace(/¨C[a-zA-Z0-9_-]+C/g, "").replace(/\s{2,}/g, " ").trim();

  // Đối với exec_command: Rút gọn các quy tắc Windows safety rules dông dài lặp lại
  if (name.includes("exec_command") || name.includes("execcommand")) {
    const firstPart = desc.split(/Windows safety rules:/i)[0].trim();
    if (firstPart) {
      desc = firstPart;
    }
  }

  // Đối với web.run hoặc web: Cắt bỏ toàn bộ phần ví dụ, citations, decision boundary, word limits dài dằng dặc
  if (name.includes("web") || desc.includes("## Examples") || desc.includes("---")) {
    desc = desc.split("\n---")[0].split("\n##")[0].trim();
  }

  // Đối với update_goal hoặc create_goal: Chỉ giữ lại 1-2 câu đầu tiên mô tả chức năng
  if (name.includes("goal") && desc.length > 200) {
    const firstSentences = desc.split("\n\n")[0];
    desc = firstSentences || desc.slice(0, 200);
  }

  // Đối với request_user_input hoặc request_user_input_async: Giữ 1-2 câu đầu mô tả chức năng
  if (name.includes("request_user_input") && desc.length > 250) {
    const firstSentences = desc.split("\n\n")[0];
    desc = firstSentences || desc.slice(0, 200);
  }

  return desc.trim();
}

/**
 * Ví dụ mẫu gọi công cụ chuẩn mực cho M365 Copilot bắt chước
 */
export const CANONICAL_TOOL_EXAMPLES = `VÍ DỤ MẪU GỌI CÔNG CỤ CHUẨN:
1. Sửa code trong file đã có (BẮT BUỘC DÙNG apply_patch *** Update File:):
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Update File: src/math.js
@@ context_anchor @@
 dòng giữ nguyên
-dòng xóa
+dòng thêm
*** End Patch
</custom_tool_call>

2. Tạo file mới hoàn toàn (BẮT BUỘC DÙNG apply_patch *** Add File:, THAY VÌ write_file):
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Add File: hello.js
+console.log('hello');
*** End Patch
</custom_tool_call>

3. Chạy câu lệnh terminal/CLI không tương tác:
<tool_call>
{"name": "exec_command", "arguments": {"command": "npm test"}}
</tool_call>

4. Đọc file từ dự án (Tối đa 1-3 tệp, tổng <= 150 dòng, có phân trang):
<tool_call>
{"name": "read_file", "arguments": {"path": "package.json", "start_line": 1, "end_line": 150}}
</tool_call>

5. Xem cấu trúc thư mục (Cấp hiện tại, depth=1):
<tool_call>
{"name": "list_dir", "arguments": {"path": "."}}
</tool_call>

6. Tìm kiếm tệp theo mẫu tên (glob pattern):
<tool_call>
{"name": "search_files", "arguments": {"pattern": "*.js", "path": "."}}
</tool_call>

7. Tìm kiếm từ khóa mã nguồn trong dự án:
<tool_call>
{"name": "grep_code", "arguments": {"query": "function calculateTotal", "path": "."}}
</tool_call>

8. Kiểm tra trạng thái thay đổi Git:
<tool_call>
{"name": "git_status", "arguments": {}}
</tool_call>`;

/**
 * Render Dynamic Tool Declaration trực tiếp từ normalized.activeCodingTools.
 * Luôn bao gồm đầy đủ schema của Core Coding Tools và bổ sung các tool mở rộng từ client.
 */
export function renderDynamicToolDeclarations(tools: NormalizedTool[]): string {
  logFunctionInput("prompts:compiler", "renderDynamicToolDeclarations", { tools });

  const additionalEntries: string[] = [];
  for (const tool of tools || []) {
    const rawName = tool.identity.name;
    const qualified = tool.identity.namespace
      ? `${tool.identity.namespace}.${rawName}`
      : rawName;
    if (CORE_TOOL_NAMES.has(rawName) || CORE_TOOL_NAMES.has(qualified)) {
      continue;
    }
    const desc = cleanToolDescription(rawName, tool.description);
    additionalEntries.push(`- ${qualified}\n  ${desc}`);
  }

  let toolListText = CORE_CODING_TOOLS_DECLARATION;
  if (additionalEntries.length > 0) {
    toolListText += `\n\n${additionalEntries.join("\n\n")}`;
  }

  return `AVAILABLE TOOLS\n\n${toolListText}\n\n${CANONICAL_TOOL_EXAMPLES}`;
}

export interface PromptSectionMetrics {
  toolDeclaration: number;
  developerInstructions: number;
  history: number;
  toolResults: number;
  environment: number;
  userRequest: number;
  finalPrompt: number;
  largestSection: string;
}

export interface PromptAuditData {
  threadId?: string;
  turnId?: string;
  toolsCount: number;
  developerRulesCount: number;
  historyTurns: number;
  toolResultsCount: number;
  toolPromptChars: number;
  historyChars: number;
  developerChars: number;
  environmentChars: number;
  finalPromptChars: number;
}

export interface PromptCompileInput {
  normalized: NormalizedCodexRequest;
  parsed: CodexParsedRequest;
  isPlanMode?: boolean;
  isImplementingPlan?: boolean;
  isNewConversation?: boolean;
}

export interface PromptCompileResult {
  finalPrompt: string;
  metrics: PromptSectionMetrics;
  audit: PromptAuditData;
  collaborationMode: "default" | "plan";
  isPlanMode: boolean;
  isImplementingPlan: boolean;
}

/**
 * Đo đạc kích thước các section và xác định section chiếm nhiều token/ký tự nhất.
 */
export function calculatePromptMetrics(sections: {
  toolDeclaration: string;
  developerInstructions: string;
  history: string;
  toolResults: string;
  environment: string;
  userRequest: string;
  finalPrompt: string;
}): PromptSectionMetrics {
  logFunctionInput("prompts:compiler", "calculatePromptMetrics", { sections });
  const lengths: Record<string, number> = {
    toolDeclaration: sections.toolDeclaration.length,
    developerInstructions: sections.developerInstructions.length,
    history: sections.history.length,
    toolResults: sections.toolResults.length,
    environment: sections.environment.length,
    userRequest: sections.userRequest.length,
  };

  let largestSection = "toolDeclaration";
  let maxLen = -1;
  for (const [key, len] of Object.entries(lengths)) {
    if (len > maxLen) {
      maxLen = len;
      largestSection = key;
    }
  }

  return {
    toolDeclaration: lengths.toolDeclaration,
    developerInstructions: lengths.developerInstructions,
    history: lengths.history,
    toolResults: lengths.toolResults,
    environment: lengths.environment,
    userRequest: lengths.userRequest,
    finalPrompt: sections.finalPrompt.length,
    largestSection,
  };
}

/**
 * Ghi nhận các chỉ số đo lường chi tiết về kích thước từng phần của prompt đã biên dịch.
 */
export function logPromptMetrics(metrics: PromptSectionMetrics): void {
  logFunctionInput("prompts:compiler", "logPromptMetrics", { metrics });
  console.log(
    `[prompt-metrics]\n` +
    `toolDeclaration=${metrics.toolDeclaration}\n` +
    `developerInstructions=${metrics.developerInstructions}\n` +
    `history=${metrics.history}\n` +
    `toolResults=${metrics.toolResults}\n` +
    `environment=${metrics.environment}\n` +
    `finalPrompt=${metrics.finalPrompt}`
  );
}

/**
 * Ghi nhận thông tin kiểm toán (audit log) về số lượng công cụ, lượt hội thoại và kích thước prompt.
 */
export function logPromptAudit(audit: PromptAuditData): void {
  logFunctionInput("prompts:compiler", "logPromptAudit", { audit });
  console.log(
    `[prompt-audit]\n` +
    `threadId=${audit.threadId || "n/a"}\n` +
    `turnId=${audit.turnId || "n/a"}\n\n` +
    `toolsCount=${audit.toolsCount}\n` +
    `developerRulesCount=${audit.developerRulesCount}\n` +
    `historyTurns=${audit.historyTurns}\n` +
    `toolResultsCount=${audit.toolResultsCount}\n\n` +
    `toolPromptChars=${audit.toolPromptChars}\n` +
    `historyChars=${audit.historyChars}\n` +
    `developerChars=${audit.developerChars}\n` +
    `environmentChars=${audit.environmentChars}\n\n` +
    `finalPromptChars=${audit.finalPromptChars}`
  );
}

/**
 * Kiểm tra xem người dùng có vừa bấm xác nhận triển khai kế hoạch hay không
 */
export function isImplementingPlanRequest(parsed: CodexParsedRequest): boolean {
  logFunctionInput("prompts:compiler", "isImplementingPlanRequest", { parsed });
  const messages = parsed.context.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(c => (c.type === "text" ? c.text : "")).join(" ")
          : "";
      if (/PLEASE IMPLEMENT THIS PLAN/i.test(text) || /Yes, implement this plan/i.test(text)) {
        return true;
      }
      break;
    }
  }
  return false;
}

/**
 * Trình biên dịch Prompt duy nhất (Unified M365 Prompt Compiler)
 * Loại bỏ hoàn toàn mâu thuẫn Plan Mode / Default Mode.
 * Rút gọn mạnh permissions + sandbox instructions.
 * Sử dụng format tool duy nhất và render dynamic tools.
 * Ghi nhận log: planMode, collaborationMode, finalPromptLength.
 */
export class M365PromptCompiler {
    /**
   * Thực hiện xử lý M365PromptCompiler.compile cho quy trình M365 Copilot Adapter.
   */
compile(input: PromptCompileInput): PromptCompileResult {
    logFunctionInput("prompts:compiler", "compile", { input });
    const { normalized, parsed } = input;

    // 1. Phân định chính xác Collaboration Mode (Loại bỏ triệt để mâu thuẫn Plan Mode / Default Mode)
    const isImplementingPlan = input.isImplementingPlan !== undefined
      ? input.isImplementingPlan
      : isImplementingPlanRequest(parsed);

    const collaborationMode: "default" | "plan" = isImplementingPlan
      ? "default"
      : (normalized.collaborationMode || "default");

    const isPlanMode = !isImplementingPlan && collaborationMode === "plan";
    const isNewConversation = input.isNewConversation ?? true;

    // -------------------------------------------------------------
    // CHẾ ĐỘ INCREMENTAL ROUNDTRIP (STATEFUL MODE - LƯỢT TIẾP THEO)
    // Tối ưu hóa cực hạn: Chỉ gửi delta (lời nhắc thực thi, tool_result mới, user instruction mới)
    // Giảm 95% token, model phản hồi nhanh tức thì, không bị quá tải ngữ cảnh!
    // -------------------------------------------------------------
    if (!isNewConversation) {
      const incrementalSections: string[] = [];

      const reminderSection = isImplementingPlan
        ? IMPLEMENT_PLAN_PROMPT
        : (isPlanMode ? `${PLAN_MODE_PROMPT}\n\n${TOOL_REMINDER_PROMPT}` : TOOL_REMINDER_PROMPT);
      incrementalSections.push(reminderSection);

      // Bổ sung danh sách tools THẲNG TỪ RAW CỦA CODEX GỬI LÊN (activeCodingTools)
      const dynamicToolsText = renderDynamicToolDeclarations(normalized.activeCodingTools);
      incrementalSections.push(dynamicToolsText);

      let toolResultsContent = "";
      if (normalized.trailingToolResults.length > 0) {
        const resultBlocks = normalized.trailingToolResults.map(res =>
          `<tool_result id="${res.callId}">\n${truncateToolResult(res.output)}\n</tool_result>`
        );
        toolResultsContent = `[KẾT QUẢ THỰC THI CÔNG CỤ VỪA NHẬN ĐƯỢC TỪ IDE]:\n${resultBlocks.join("\n\n")}\n\nHãy phân tích kết quả trên. Nếu cần thực hiện bước kế tiếp, hãy xuất khối công cụ tương ứng (luôn dùng apply_patch thay vì write_file nếu tạo/sửa file, hoặc exec_command). Nếu đã hoàn thành nhiệm vụ, hãy trả lời kết luận cho người dùng.`;
        incrementalSections.push(toolResultsContent);
      }

      let userReqContent = "";
      if (normalized.latestUserInstruction) {
        userReqContent = `[YÊU CẦU CỦA NGƯỜI DÙNG]:\n${normalized.latestUserInstruction}`;
        incrementalSections.push(userReqContent);
      }

      // Luôn luôn kết thúc bằng chỉ thị 4-backtick markdown bắt buộc (Tinh túy 1)
      incrementalSections.push(isPlanMode ? MANDATORY_4_BACKTICK_PLAN_MODE_PROMPT : MANDATORY_4_BACKTICK_MARKDOWN_PROMPT);

      const finalPrompt = incrementalSections.join("\n\n").trim();

      console.log(
        `planMode=${isPlanMode}\n` +
        `collaborationMode=${collaborationMode}\n` +
        `finalPromptLength=${finalPrompt.length}\n` +
        `mode=incremental_stateful`
      );

      const metrics = calculatePromptMetrics({
        toolDeclaration: `${reminderSection}\n\n${dynamicToolsText}`,
        developerInstructions: "",
        history: "",
        toolResults: toolResultsContent,
        environment: "",
        userRequest: userReqContent,
        finalPrompt,
      });

      const audit: PromptAuditData = {
        threadId: normalized.threadId,
        turnId: normalized.turnId,
        toolsCount: normalized.activeCodingTools.length,
        developerRulesCount: 0,
        historyTurns: 0,
        toolResultsCount: normalized.trailingToolResults.length,
        toolPromptChars: reminderSection.length + dynamicToolsText.length,
        historyChars: 0,
        developerChars: 0,
        environmentChars: 0,
        finalPromptChars: finalPrompt.length,
      };

      return {
        finalPrompt,
        metrics,
        audit,
        collaborationMode,
        isPlanMode,
        isImplementingPlan,
      };
    }

    const sections: string[] = [];

    // 2. Giao thức tương tác văn bản thống nhất + Dynamic Tool Declaration
    const dynamicToolsText = renderDynamicToolDeclarations(normalized.activeCodingTools);
    const toolDeclarationSection = `${UNIFIED_TOOL_PROTOCOL}\n\n${dynamicToolsText}`;
    sections.push(toolDeclarationSection);

    // 3. Chỉ dẫn Plan Mode hoặc Triển khai kế hoạch nếu có (Chỉ khi thực sự active)
    if (isPlanMode) {
      sections.push(PLAN_MODE_PROMPT);
    } else if (isImplementingPlan) {
      sections.push(IMPLEMENT_PLAN_PROMPT);
    }

    // 4. System Instructions từ Codex IDE (Lọc bỏ các hướng dẫn nội bộ thừa)
    let devInstructionsContent = "";
    if (parsed.context?.systemPrompt && parsed.context.systemPrompt.length > 0) {
      const filteredSystem = parsed.context.systemPrompt
        .map(sp => sp.trim())
        .filter(
          sp =>
            sp.length > 0 &&
            !sp.startsWith("<environment_context>") &&
            !sp.includes("spawn_agent") &&
            !sp.includes("You are Codex, a coding assistant") &&
            !sp.includes("You are Codex") &&
            !sp.includes("<permissions") &&
            !sp.includes("<sandbox")
        )
        .map(sp => sp.replace(/¨C[a-zA-Z0-9_-]+C/g, "").trim())
        .filter(sp => sp.length > 0)
        .join("\n\n");
      if (filteredSystem) {
        devInstructionsContent = `[System Instructions]:\n${filteredSystem}`;
        sections.push(devInstructionsContent);
      }
    }

    // 5. Ngữ cảnh Môi trường làm việc (Environment Context)
    let envContent = "";
    if (normalized.environmentContext) {
      envContent = `[NGỮ CẢNH DỰ ÁN & MÔI TRƯỜNG]:\n${normalized.environmentContext}`;
      sections.push(envContent);
    }

    // 6. Chỉ thị của Dự án / Developer Rules (Đã được lọc sạch permissions và sandbox instructions)
    if (normalized.developerInstructions && normalized.developerInstructions.length > 0) {
      const cleanedRules = normalized.developerInstructions
        .map(r => r.replace(/¨C[a-zA-Z0-9_-]+C/g, "").trim())
        .filter(r => r.length > 0);
      if (cleanedRules.length > 0) {
        const devRules = cleanedRules.map(r => `- ${r}`).join("\n");
        const devBlock = `[CHỈ THỊ CỦA DỰ ÁN / DEVELOPER RULES]:\n${devRules}`;
        devInstructionsContent = devInstructionsContent ? `${devInstructionsContent}\n\n${devBlock}` : devBlock;
        sections.push(devBlock);
      }
    }

    // 7. Lịch sử trao đổi đầy đủ
    let historyContent = "";
    if (normalized.priorHistory.length > 0) {
      const historyLines: string[] = [];
      for (const h of normalized.priorHistory) {
        if (h.role === "user") {
          historyLines.push(`Người dùng: ${h.content}`);
        } else if (h.role === "assistant") {
          historyLines.push(`Trợ lý: ${h.content}`);
        } else if (h.role === "tool") {
          historyLines.push(`<tool_result id="${h.callId || ""}">\n${truncateToolResult(h.content)}\n</tool_result>`);
        }
      }
      if (historyLines.length > 0) {
        historyContent = `[LỊCH SỬ TRAO ĐỔI]:\n${historyLines.join("\n\n")}`;
        sections.push(historyContent);
      }
    }

    // 8. Kết quả Tool gần nhất (Trailing tool results của turn hiện tại)
    let toolResultsContent = "";
    if (normalized.trailingToolResults.length > 0) {
      const resultBlocks = normalized.trailingToolResults.map(res =>
        `<tool_result id="${res.callId}">\n${truncateToolResult(res.output)}\n</tool_result>`
      );
      toolResultsContent = `[KẾT QUẢ THỰC THI CÔNG CỤ VỪA NHẬN ĐƯỢC TỪ IDE]:\n${resultBlocks.join("\n\n")}\n\nHãy phân tích kết quả trên. Nếu cần thực hiện bước kế tiếp, hãy xuất khối công cụ tương ứng (luôn dùng apply_patch thay vì write_file nếu tạo/sửa file, hoặc exec_command). Nếu đã hoàn thành nhiệm vụ, hãy trả lời kết luận cho người dùng.`;
      sections.push(toolResultsContent);
    }

    // 9. Yêu cầu của người dùng mới nhất
    let userReqContent = "";
    if (normalized.latestUserInstruction) {
      userReqContent = `[YÊU CẦU CỦA NGƯỜI DÙNG]:\n${normalized.latestUserInstruction}`;
      sections.push(userReqContent);
    }

    // 10. Chỉ thị Fast-Path 4 backticks ở cuối cùng
    sections.push(isPlanMode ? MANDATORY_4_BACKTICK_PLAN_MODE_PROMPT : MANDATORY_4_BACKTICK_MARKDOWN_PROMPT);

    let finalPrompt = sections.join("\n\n").trim();

    // Budget Guard: Cắt tỉa nếu vượt quá ngưỡng an toàn
    if (finalPrompt.length > MAX_M365_PROMPT_CHARS) {
      const headLimit = 25_000;
      const tailLimit = MAX_M365_PROMPT_CHARS - headLimit - 200;
      const head = finalPrompt.slice(0, headLimit);
      const tail = finalPrompt.slice(-tailLimit);
      finalPrompt = `${head}\n\n... [Một số ngữ cảnh cũ được rút gọn để tối ưu độ dài cho M365 Copilot] ...\n\n${tail}`;
    }

    // Yêu cầu 4: Thêm log bắt buộc
    console.log(
      `planMode=${isPlanMode}\n` +
      `collaborationMode=${collaborationMode}\n` +
      `finalPromptLength=${finalPrompt.length}`
    );

    const metrics = calculatePromptMetrics({
      toolDeclaration: toolDeclarationSection,
      developerInstructions: devInstructionsContent,
      history: historyContent,
      toolResults: toolResultsContent,
      environment: envContent,
      userRequest: userReqContent,
      finalPrompt,
    });

    const audit: PromptAuditData = {
      threadId: normalized.threadId,
      turnId: normalized.turnId,
      toolsCount: normalized.activeCodingTools.length,
      developerRulesCount: normalized.developerInstructions?.length || 0,
      historyTurns: normalized.priorHistory.length,
      toolResultsCount: normalized.trailingToolResults.length,
      toolPromptChars: toolDeclarationSection.length,
      historyChars: historyContent.length,
      developerChars: devInstructionsContent.length,
      environmentChars: envContent.length,
      finalPromptChars: finalPrompt.length,
    };

    return {
      finalPrompt,
      metrics,
      audit,
      collaborationMode,
      isPlanMode,
      isImplementingPlan,
    };
  }
}

export const promptCompiler = new M365PromptCompiler();
