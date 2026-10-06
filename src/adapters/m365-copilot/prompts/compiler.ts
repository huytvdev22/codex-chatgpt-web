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
export const UNIFIED_TOOL_PROTOCOL = `[HỆ THỐNG GIAO TIẾP VĂN BẢN VỚI IDE - TEXT INTERACTION PROTOCOL]
Bạn là Trợ lý Lập trình viên AI hỗ trợ phát triển dự án của người dùng.
Hệ thống IDE trên máy tính người dùng tự động bắt lấy văn bản bạn in ra, chạy trực tiếp trên dự án cục bộ và trả kết quả vào thẻ <tool_result> cho bạn ở lượt kế tiếp.

QUY TẮC ĐỊNH DẠNG CÔNG CỤ (GIAO THỨC COGNITIVE ENVELOPE):
Trước khi gọi công cụ, BẮT BUỘC có khối <thought> để suy nghĩ, kèm 1 câu dẫn dắt ngắn gọn mô tả hành động sắp làm:

1. Đối với công cụ thông thường (chạy lệnh shell, gọi hàm):
<thought>
[Suy luận nội tâm: phân tích tình hình, giải thích vì sao chọn công cụ này và bước tiếp theo là gì]
</thought>
[Một câu dẫn dắt mô tả hành động sắp làm]
<tool_call>
{"name": "<TOOL_NAME>", "arguments": {"<PARAM_NAME>": "<VALUE>"}}
</tool_call>

2. ĐẶC BIỆT KHI CHỈNH SỬA HOẶC TẠO FILE (apply_patch):
BẮT BUỘC sử dụng khối Freeform chuẩn dưới đây (TUYỆT ĐỐI KHÔNG bọc trong JSON):
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
(Khi tạo file mới: Sử dụng *** Add File: path/to/file.ext thay vì Update File).

QUY TẮC QUAN TRỌNG VỀ THAO TÁC FILE VÀ TERMINAL:
- TẠO FILE MỚI HOẶC SỬA FILE: Ưu tiên sử dụng <custom_tool_call name="apply_patch"> (với *** Add File: hoặc *** Update File:) hoặc công cụ write_file.
- NGHIÊM CẤM TUYỆT ĐỐI: Không được dùng các lệnh shell (cat <<EOF, cat >, echo >, python, perl, heredoc) để tạo file hoặc ghi đè nội dung file trong exec_command.
- PHẠM VI CỦA exec_command: Chỉ dùng để chạy các câu lệnh dòng lệnh không tương tác (như: npm install, npm test, git status, git diff, mkdir -p ..., node server.js).

QUY TẮC ỨNG XỬ:
- Khi người dùng chào hỏi, hỏi đáp kiến thức, giải thích code: Trả lời tự nhiên bằng văn bản Markdown thông thường. TUYỆT ĐỐI KHÔNG xuất câu lệnh terminal hay thẻ <tool_call>.
- Khi người dùng yêu cầu thao tác cụ thể trên dự án: Hãy suy nghĩ trong thẻ <thought>, kèm câu dẫn dắt ngắn gọn trước khi xuất thẻ <tool_call>.
- Tuyệt đối không tự chế tên công cụ hoặc dùng các tên alias không có trong danh sách AVAILABLE TOOLS dưới đây.`;

// Alias để tương thích ngược cho các module đang import MINIMAL_TOOL_PROTOCOL
export const MINIMAL_TOOL_PROTOCOL = UNIFIED_TOOL_PROTOCOL;

/**
 * Rút gọn mô tả công cụ thông minh, loại bỏ các tài liệu dông dài của OpenAI (như hướng dẫn web browsing, citations, word limits).
 */
export function cleanToolDescription(name: string, rawDesc?: string): string {
  logFunctionInput("prompts:compiler", "cleanToolDescription", { name, rawDesc });
  if (!rawDesc) return "No description provided.";
  let desc = rawDesc.trim();

  // Đối với web.run hoặc web: Cắt bỏ toàn bộ phần ví dụ, citations, decision boundary, word limits dài dằng dặc
  if (name.includes("web") || desc.includes("## Examples") || desc.includes("---")) {
    desc = desc.split("\n---")[0].split("\n##")[0].trim();
  }

  // Đối với update_goal hoặc create_goal: Chỉ giữ lại 1-2 câu đầu tiên mô tả chức năng
  if (name.includes("goal") && desc.length > 250) {
    const firstSentences = desc.split("\n\n")[0];
    desc = firstSentences || desc.slice(0, 200);
  }

  return desc;
}

/**
 * Ví dụ mẫu gọi công cụ chuẩn mực cho M365 Copilot bắt chước
 */
export const CANONICAL_TOOL_EXAMPLES = `VÍ DỤ MẪU GỌI CÔNG CỤ CHUẨN:
1. Sửa code trong file đã có (MẶC ĐỊNH BẮT BUỘC DÙNG apply_patch):
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Update File: src/math.js
@@ context_anchor @@
 dòng giữ nguyên
-dòng xóa
+dòng thêm
*** End Patch
</custom_tool_call>

2. Tạo file mới hoặc ghi đè toàn bộ file (Dùng write_file hoặc apply_patch *** Add File:):
<tool_call>
{"name": "write_file", "arguments": {"path": "hello.js", "content": "console.log('hello');"}}
</tool_call>

3. Chạy câu lệnh terminal/CLI không tương tác:
<tool_call>
{"name": "exec_command", "arguments": {"command": "npm test"}}
</tool_call>

4. Đọc file từ dự án:
<tool_call>
{"name": "read_file", "arguments": {"path": "package.json"}}
</tool_call>`;

/**
 * Render Dynamic Tool Declaration trực tiếp từ normalized.activeCodingTools.
 * Sử dụng một định dạng tên công cụ duy nhất từ Codex kèm ví dụ mẫu trực quan.
 */
export function renderDynamicToolDeclarations(tools: NormalizedTool[]): string {
  logFunctionInput("prompts:compiler", "renderDynamicToolDeclarations", { tools });
  if (!tools || tools.length === 0) {
    return `AVAILABLE TOOLS\n(Không có công cụ bổ sung nào được khai báo trong lượt này)\n\n${CANONICAL_TOOL_EXAMPLES}`;
  }

  const entries = tools.map(tool => {
    const qualified = tool.identity.namespace
      ? `${tool.identity.namespace}.${tool.identity.name}`
      : tool.identity.name;
    const desc = cleanToolDescription(tool.identity.name, tool.description);
    return `- ${qualified}\n  ${desc}`;
  });

  // Nếu trong danh sách chưa có write_file, bổ sung công cụ write_file do Tool Bridge hỗ trợ
  const hasWriteFile = tools.some(t => t.identity.name === "write_file");
  if (!hasWriteFile) {
    entries.push("- write_file\n  Tạo file mới hoặc ghi đè nội dung file (tham số: path, content).");
  }

  return `AVAILABLE TOOLS\n\n${entries.join("\n\n")}\n\n${CANONICAL_TOOL_EXAMPLES}`;
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
        toolResultsContent = `[KẾT QUẢ THỰC THI CÔNG CỤ VỪA NHẬN ĐƯỢC TỪ IDE]:\n${resultBlocks.join("\n\n")}\n\nHãy phân tích kết quả trên. Nếu cần thực hiện bước kế tiếp, hãy xuất khối công cụ tương ứng (apply_patch hoặc write_file nếu sửa/tạo file, hoặc exec_command). Nếu đã hoàn thành nhiệm vụ, hãy trả lời kết luận cho người dùng.`;
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
            !sp.includes("<permissions") &&
            !sp.includes("<sandbox")
        )
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
      const devRules = normalized.developerInstructions.map(r => `- ${r}`).join("\n");
      const devBlock = `[CHỈ THỊ CỦA DỰ ÁN / DEVELOPER RULES]:\n${devRules}`;
      devInstructionsContent = devInstructionsContent ? `${devInstructionsContent}\n\n${devBlock}` : devBlock;
      sections.push(devBlock);
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
      toolResultsContent = `[KẾT QUẢ THỰC THI CÔNG CỤ VỪA NHẬN ĐƯỢC TỪ IDE]:\n${resultBlocks.join("\n\n")}\n\nHãy phân tích kết quả trên. Nếu cần thực hiện bước kế tiếp, hãy xuất khối công cụ tương ứng. Nếu đã hoàn thành nhiệm vụ, hãy trả lời kết luận cho người dùng.`;
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
