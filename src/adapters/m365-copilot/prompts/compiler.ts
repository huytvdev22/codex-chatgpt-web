
import type { CodexParsedRequest } from "../../../types";
import type { NormalizedCodexRequest, NormalizedTool } from "../normalization/canonical-types";
import {
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  TOOL_REMINDER_PROMPT,
  M365_IMAGE_ATTACHMENT_HINT,
  buildUnifiedToolProtocol,
  UNIFIED_TOOL_PROTOCOL as UNIFIED_TOOL_PROTOCOL_TEMPLATE,
  MINIMAL_TOOL_PROTOCOL as MINIMAL_TOOL_PROTOCOL_TEMPLATE,
  SHORT_OUTPUT_FORMAT_ANCHOR,
  SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
  formatUserInputAnswers,
} from "./templates";
import { conversationScenarioBuilder } from "./conversation-scenario-builder";
import { hasActualPriorAssistantReply } from "../../base";

const MAX_M365_PROMPT_CHARS = 95_000;
const MAX_TOOL_RESULT_CHARS = 8_000;
const MAX_COMPACT_TOOL_DESCRIPTION_CHARS = 320;
const MAX_FULL_TOOL_DESCRIPTION_CHARS = 1_200;

/**
 * Viết lại mô tả action cho M365 thay vì forward nguyên văn instruction dài
 * từ Codex. Contract kỹ thuật như wire_name, kind và parameters vẫn giữ nguyên.
 */
function curateToolDescription(
  tool: NormalizedTool,
  compact: boolean
): string {
  const wireName =
    tool.identity.qualifiedName || tool.identity.name;
  const canonicalDescriptions: Record<string, string> = {
    exec_command:
      "Chạy câu lệnh CLI không tương tác trong môi trường và shell đã khai báo. Chỉ dùng khi không có semantic action phù hợp.",
    write_stdin:
      "Gửi thêm dữ liệu vào phiên exec_command đang chạy bằng session_id.",
    list_mcp_resources:
      "Liệt kê resource do MCP server cung cấp. Chỉ dùng khi yêu cầu cần dữ liệu từ MCP resource.",
    list_mcp_resource_templates:
      "Liệt kê resource template do MCP server cung cấp.",
    read_mcp_resource:
      "Đọc một MCP resource bằng server và URI chính xác.",
    request_user_input:
      "Mở hộp thoại hỏi người dùng khi action khả dụng và cần làm rõ thông tin quan trọng.",
    apply_patch:
      "Tạo hoặc sửa file bằng raw patch. Đây là freeform action; không bọc patch trong JSON arguments.",
    view_image:
      "Mở ảnh cục bộ để kiểm tra trực quan.",
    get_goal:
      "Đọc trạng thái goal hiện tại khi workflow goal được sử dụng.",
    create_goal:
      "Tạo goal chỉ khi người dùng hoặc instruction yêu cầu rõ ràng.",
    update_goal:
      "Cập nhật trạng thái goal hiện tại theo đúng lifecycle được hỗ trợ.",
    "web.run":
      "Truy cập web khi yêu cầu cần thông tin trực tuyến, dữ liệu mới hoặc nguồn bên ngoài. Chỉ truyền các tham số đúng schema.",
    "image_gen.imagegen":
      "Tạo hoặc chỉnh sửa hình ảnh khi người dùng yêu cầu nội dung trực quan.",
  };

  const curated =
    canonicalDescriptions[wireName] ||
    canonicalDescriptions[tool.identity.name];
  if (curated) return curated;

  const raw = (tool.description || "Không có mô tả.")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = cleanToolDescription(wireName, raw);
  const maxChars = compact
    ? MAX_COMPACT_TOOL_DESCRIPTION_CHARS
    : MAX_FULL_TOOL_DESCRIPTION_CHARS;

  return cleaned.length > maxChars
    ? `${cleaned.slice(0, maxChars).trimEnd()}…`
    : cleaned;
}

/**
 * Loại bỏ instruction nội bộ của Codex khỏi prompt gửi sang M365.
 * Chỉ giữ project/developer rules có ý nghĩa đối với quá trình thực thi.
 */
export function sanitizeCodexInstructions(text: string): string {
  return text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, "")
    .replace(/<apps_instructions>[\s\S]*?<\/apps_instructions>/gi, "")
    .replace(/<plugins_instructions>[\s\S]*?<\/plugins_instructions>/gi, "")
    .replace(/<tools>[\s\S]*?<\/tools>/gi, "")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, "")
    .replace(/<permissions[\s\S]*?<\/permissions[^>]*>/gi, "")
    .replace(/<sandbox[\s\S]*?<\/sandbox[^>]*>/gi, "")
    .replace(
      /<\/?(?:collaboration_mode|apps_instructions|plugins_instructions|tools|skills_instructions)>/gi,
      ""
    )
    .replace(/# Apps \(Connectors\)[\s\S]*?(?=\n# |\n\[|$)/gi, "")
    .replace(/# Plugins[\s\S]*?(?=\n# |\n\[|$)/gi, "")
    .replace(/Deferred tool namespaces:[\s\S]*?(?=\n# |\n\[|$)/gi, "")
    .replace(/You are Codex[\s\S]*?(?=\n# |\n\[|$)/gi, "")
    .replace(/(?:^|\n)\s*[-*]?\s*Use the `?request_user_input`? tool[\s\S]*?(?=\n# |\n\[|\n<|$|\n\n[A-ZÀ-Ỹ])/gi, "")
    .replace(/If `?request_user_input`? returns no answers[\s\S]*?(?=\n# |\n\[|\n<|$|\n\n[A-ZÀ-Ỹ])/gi, "")
    .replace(/Never use the `?request_user_input`? tool[\s\S]*?(?=\n# |\n\[|\n<|$|\n\n[A-ZÀ-Ỹ])/gi, "")
    .replace(/If explicit user input is required for another reason[\s\S]*?(?=\n# |\n\[|\n<|$|\n\n[A-ZÀ-Ỹ])/gi, "")
    .replace(/Never write a multiple choice question as a textual assistant message\.?/gi, "")
    .replace(/(?:^|\n)[^\n]*`?request_user_input`?[^\n]*(?:\n|$)/gi, "\n")
    .replace(/¨C[a-zA-Z0-9_-]+C/g, "")
    .trim();
}

/**
 * Thực hiện xử lý truncateToolResult cho quy trình M365 Copilot Adapter.
 */
export function truncateToolResult(content: string, maxChars = MAX_TOOL_RESULT_CHARS): string {

  if (content.length <= maxChars) return content;
  const half = Math.floor((maxChars - 200) / 2);
  const head = content.slice(0, half);
  const tail = content.slice(-half);
  const omitted = content.length - (head.length + tail.length);
  return `${head}\n\n[... Đã lược bớt ${omitted} ký tự ở giữa để tối ưu kích thước phản hồi ...]\n\n${tail}`;
}
/**
 * Rút gọn mô tả công cụ thông minh, loại bỏ các tài liệu dông dài của OpenAI và control tokens rác.
 */
export function cleanToolDescription(name: string, rawDesc?: string): string {

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
 * Sinh ví dụ transport tối thiểu dựa trên đúng inventory của turn hiện tại.
 * Không quảng bá tool không tồn tại và không duy trì bộ ví dụ hard-code.
 */
function renderDynamicToolExamples(tools: NormalizedTool[], compact = false): string {
  const preferredFunctionNames = ["exec_command", "read_file", "view_file"];
  const functionTool =
    tools.find(tool => tool.kind === "function" && preferredFunctionNames.includes(tool.identity.name)) ||
    tools.find(tool => tool.kind === "function");

  const applyPatchTool = tools.find(
    tool => tool.kind === "custom" && tool.identity.name === "apply_patch"
  );
  const examples: string[] = [];

  if (functionTool?.kind === "function") {
    const wireName =
      functionTool.identity.qualifiedName || functionTool.identity.name;
    const required = Array.isArray(functionTool.rawParameters.required)
      ? functionTool.rawParameters.required.map(String)
      : [];
    const properties =
      functionTool.rawParameters.properties &&
        typeof functionTool.rawParameters.properties === "object" &&
        !Array.isArray(functionTool.rawParameters.properties)
        ? functionTool.rawParameters.properties as Record<string, unknown>
        : {};
    const argumentsExample = Object.fromEntries(
      required.map(name => {
        const schema = properties[name];
        const type =
          schema &&
            typeof schema === "object" &&
            !Array.isArray(schema) &&
            typeof (schema as Record<string, unknown>).type === "string"
            ? (schema as Record<string, unknown>).type
            : "string";
        const value =
          type === "number" || type === "integer"
            ? 1
            : type === "boolean"
              ? true
              : type === "array"
                ? []
                : type === "object"
                  ? {}
                  : `<${name}>`;
        return [name, value];
      })
    );

    examples.push(`- Mẫu 1: Gọi công cụ function (đặt JSON arguments vào thẻ <tool_call>):
\`\`\`\`markdown
<webResponse>
<tool_call>
${JSON.stringify({ name: wireName, arguments: argumentsExample })}
</tool_call>
</webResponse>
\`\`\`\``);
  }

  if (applyPatchTool) {
    const wireName =
      applyPatchTool.identity.qualifiedName || applyPatchTool.identity.name;
    examples.push(`- Mẫu 2: Sửa file bằng apply_patch (đặt nội dung diff vào thẻ <custom_tool_call>):
\`\`\`\`markdown
<webResponse>
<custom_tool_call name="${wireName}">
*** Begin Patch
*** Update File: path/to/file.ext
@@
-old content
+new content
*** End Patch
</custom_tool_call>
</webResponse>
\`\`\`\`

File chưa tồn tại dùng *** Add File. File đã tồn tại dùng *** Update File.
Không dùng *** Add File để giả định ghi đè file đã tồn tại.`);
  }

  return examples.length > 0
    ? `[VÍ DỤ CÚ PHÁP GỌI CÔNG CỤ TRÊN MÁY MÌNH]\n(Khi cần thực thi, hãy đặt lệnh trong thẻ tương ứng bên dưới):\n\n${examples.join("\n\n")}`
    : "";
}

/**
 * Render Tool Declaration chuẩn mực cho M365 Copilot.
 * Sinh inventory trực tiếp từ native tools do Codex cung cấp, tương tự mô hình
 * codex_tool_inventory của ChatGPT Web. M365 phải gọi đúng qualifiedName
 * và truyền arguments theo đúng JSON Schema được quảng bá.
 */
export function renderDynamicToolDeclarations(tools: NormalizedTool[] = []): string {
  if (tools.length === 0) {
    return "[DANH SÁCH CÔNG CỤ MÁY MÌNH HỖ TRỢ CHO BẠN Ở LƯỢT NÀY]\n\nHiện không có công cụ nào khả dụng cho lượt này.";
  }

  const formatSchemaType = (schema: unknown): string => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return "unknown";
    }

    const record = schema as Record<string, unknown>;
    if (typeof record.type === "string") {
      return record.type;
    }
    if (Array.isArray(record.type)) {
      return record.type.map(String).join(" | ");
    }
    if (Array.isArray(record.enum) && record.enum.length > 0) {
      return "enum";
    }
    return "unknown";
  };

  const formatSchemaDescription = (schema: unknown): string => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return "";
    }

    const record = schema as Record<string, unknown>;
    const description =
      typeof record.description === "string"
        ? record.description.replace(/\s+/g, " ").trim()
        : "";
    const enumValues = Array.isArray(record.enum)
      ? record.enum.map(value => JSON.stringify(value)).join(" | ")
      : "";

    return [
      description,
      enumValues ? `Giá trị hợp lệ: ${enumValues}.` : "",
    ].filter(Boolean).join(" ");
  };

  const inventory = tools.map((tool, index) => {
    const wireName = tool.identity.qualifiedName || tool.identity.name;
    const header =
      `${index + 1}. ${wireName} ` +
      `(${tool.kind === "custom" ? "freeform" : "function"})`;
    const lines = [
      header,
      `   Mô tả: ${curateToolDescription(tool, false)}`,
    ];

    if (tool.identity.namespace) {
      lines.push(`   Namespace: ${tool.identity.namespace}`);
    }

    if (tool.kind === "custom") {
      lines.push(
        "   Input: raw text hoàn chỉnh; không bọc trong arguments JSON."
      );
      if (tool.format !== undefined) {
        lines.push("   Ràng buộc: input phải tuân theo grammar/format được IDE cung cấp.");
      }
      return lines.join("\n");
    }

    const required = new Set(
      Array.isArray(tool.rawParameters.required)
        ? tool.rawParameters.required.map(String)
        : []
    );
    const properties =
      tool.rawParameters.properties &&
        typeof tool.rawParameters.properties === "object" &&
        !Array.isArray(tool.rawParameters.properties)
        ? tool.rawParameters.properties as Record<string, unknown>
        : {};
    const entries = Object.entries(properties);

    if (entries.length === 0) {
      lines.push("   Tham số: không có.");
      return lines.join("\n");
    }

    lines.push("   Tham số:");
    for (const [name, schema] of entries) {
      const requiredLabel = required.has(name) ? "bắt buộc" : "tùy chọn";
      const description = formatSchemaDescription(schema);
      lines.push(
        `   - ${name}: ${formatSchemaType(schema)}, ${requiredLabel}` +
        `${description ? ` — ${description}` : ""}`
      );
    }

    return lines.join("\n");
  }).join("\n\n");

  const examples = renderDynamicToolExamples(tools);

  return `[DANH SÁCH CÔNG CỤ MÁY MÌNH HỖ TRỢ CHO BẠN Ở LƯỢT NÀY]

Dưới đây là các công cụ mà script trên máy mình đã kết nối sẵn để thực thi giúp bạn:
- Bạn chỉ cần dùng đúng tên công cụ dưới đây và truyền đúng các tham số theo schema.
- Với công cụ dạng function: xuất thẻ <tool_call> kèm JSON arguments đúng tham số.
- Với công cụ freeform (apply_patch): xuất trong <custom_tool_call name="apply_patch"> (không bọc trong JSON).
- Nếu đã có công cụ đọc/sửa file phù hợp, bạn ưu tiên dùng hơn là chạy lệnh shell exec_command nhé.
- Bạn không cần dùng các công cụ tìm kiếm web hay python nội bộ của M365, cứ dùng các công cụ dưới đây để thao tác trực tiếp trên máy mình.

${inventory}

${examples}`;
}

/**
 * Render Tool Declaration phiên bản COMPACT cho M365 Copilot từ Turn 2 trở đi.
 * Vẫn lấy từ inventory thực tế để không quảng bá tool đã biến mất khỏi turn hiện tại.
 */
export function renderCompactDynamicToolDeclarations(tools: NormalizedTool[] = []): string {
  if (tools.length === 0) {
    return "[DANH SÁCH CÔNG CỤ HỖ TRỢ (RÚT GỌN)]: Hiện không có công cụ nào khả dụng.";
  }

  const inventory = tools.map(tool => {
    const wireName = tool.identity.qualifiedName || tool.identity.name;
    if (tool.kind === "custom") {
      return `- ${wireName} [freeform] — ${curateToolDescription(tool, true)}`;
    }

    const required = Array.isArray(tool.rawParameters.required)
      ? tool.rawParameters.required.map(String)
      : [];
    const properties =
      tool.rawParameters.properties &&
        typeof tool.rawParameters.properties === "object" &&
        !Array.isArray(tool.rawParameters.properties)
        ? Object.keys(tool.rawParameters.properties as Record<string, unknown>)
        : [];
    const fields = properties.map(name => required.includes(name) ? `${name}*` : name);

    return `- ${wireName} [function]${fields.length > 0 ? `: ${fields.join(", ")}` : ""} — ${curateToolDescription(tool, true)}`;
  }).join("\n");

  const examples = renderDynamicToolExamples(tools, true);

  return `[DANH SÁCH CÔNG CỤ HỖ TRỢ (RÚT GỌN)]
(Các trường có dấu * là tham số bắt buộc; công cụ function dùng JSON arguments; apply_patch dùng raw text):
${inventory}

${examples}`;
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
  parsed?: CodexParsedRequest;
  isPlanMode?: boolean;
  isImplementingPlan?: boolean;
  isNewConversation?: boolean;
  assistantName?: string;
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
export function isImplementingPlanRequest(parsed?: CodexParsedRequest): boolean {

  const messages = parsed?.context?.messages || [];
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
  constructor(readonly options?: { assistantName?: string }) {}

  /**
   * Thực hiện xử lý M365PromptCompiler.compile cho quy trình M365 Copilot Adapter.
   */
  compile(input: PromptCompileInput): PromptCompileResult {
    const { normalized, parsed } = input;

    // 1. Phân định chính xác Collaboration Mode (Loại bỏ triệt để mâu thuẫn Plan Mode / Default Mode)
    const isImplementingPlan = input.isImplementingPlan !== undefined
      ? input.isImplementingPlan
      : isImplementingPlanRequest(parsed);

    const collaborationMode: "default" | "plan" = isImplementingPlan
      ? "default"
      : (normalized.collaborationMode || "default");

    const isPlanMode = !isImplementingPlan && collaborationMode === "plan";

    const hasToolResults = normalized.trailingToolResults.length > 0;

    // Xác định isNewConversation:
    // 1. Nếu caller truyền tường minh giá trị boolean (true/false), tôn trọng quyết định từ adapter.
    // 2. Nếu undefined, tự động suy luận an toàn: nếu chưa có tin nhắn trợ lý thực tế và chưa có tool results -> true.
    let isNewConversation = input.isNewConversation;
    if (isNewConversation === undefined) {
      const hasPriorAssistant = hasActualPriorAssistantReply(parsed?.context?.messages) ||
        normalized.priorHistory.some(h => h.role === "assistant" && typeof h.content === "string" && h.content.trim().length > 0);
      isNewConversation = !hasPriorAssistant && !hasToolResults;
    }

    // 2. Chuẩn bị các thành phần nội dung ngữ cảnh đã được làm sạch
    const actionContractText = isNewConversation
      ? renderDynamicToolDeclarations(normalized.activeCodingTools)
      : renderCompactDynamicToolDeclarations(normalized.activeCodingTools);

    let environmentText = "";
    if (normalized.environmentContext) {
      environmentText = `[Thư mục làm việc trên máy mình]:\n${normalized.environmentContext}`;
    }

    let devInstructionsContent = "";
    if (parsed?.context?.systemPrompt && parsed.context.systemPrompt.length > 0) {
      const filteredSystem = parsed.context.systemPrompt
        .map(sp => sanitizeCodexInstructions(sp))
        .filter(
          sp =>
            sp.length > 0 &&
            !sp.includes("spawn_agent") &&
            !sp.includes("You are Codex, a coding assistant")
        )
        .filter(sp => sp.length > 0)
        .join("\n\n");
      if (filteredSystem) {
        devInstructionsContent = `[Chỉ dẫn từ hệ thống]:\n${filteredSystem}`;
      }
    }

    let developerRulesText = "";
    if (normalized.developerInstructions && normalized.developerInstructions.length > 0) {
      const cleanedRules = normalized.developerInstructions
        .map(r => sanitizeCodexInstructions(r))
        .filter(r => r.length > 0);
      if (cleanedRules.length > 0) {
        const devRules = cleanedRules.map(r => `- ${r}`).join("\n");
        developerRulesText = `[Một số quy ước làm việc trong dự án của mình]:\n${devRules}`;
        devInstructionsContent = devInstructionsContent
          ? `${devInstructionsContent}\n\n${developerRulesText}`
          : developerRulesText;
      }
    }

    let priorHistoryText = "";
    if (isNewConversation && normalized.priorHistory.length > 0) {
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
        priorHistoryText = `[Lịch sử trao đổi trước đó]:\n${historyLines.join("\n\n")}`;
      }
    }

    let toolResultsText = "";
    if (normalized.trailingToolResults.length > 0) {
      const resultBlocks = normalized.trailingToolResults.map(res => {
        const content = truncateToolResult(res.output);
        const isFenced = content.startsWith("```");
        const safeBody = isFenced ? content : `\`\`\`\n${content}\n\`\`\``;
        return `<tool_result id="${res.callId}">\n${safeBody}\n</tool_result>`;
      });
      toolResultsText = `[Kết quả các lệnh vừa chạy xong]:\n${resultBlocks.join("\n\n")}`;
    }

    let userInstructionText = "";
    if (normalized.latestUserInstruction) {
      userInstructionText = `[Yêu cầu hiện tại của mình]:\n${normalized.latestUserInstruction}`;
    }

    const hasToolErrors = normalized.trailingToolResults.some(
      r =>
        r.output.includes("Process exited with code 1") ||
        r.output.includes("exit code: 1") ||
        r.output.includes("Exit code: 1") ||
        r.output.startsWith("Error:") ||
        r.output.startsWith("Lỗi:") ||
        r.output.includes("Command failed:")
    );

    // Nhận diện xem có kết quả trả lời của request_user_input hay không
    const userInputToolResult = normalized.trailingToolResults.find(res => {
      if (res.toolName === "request_user_input" || res.callId.toLowerCase().includes("request_user_input")) {
        return true;
      }
      try {
        const raw = typeof res.output === "string" ? res.output.trim() : "";
        if (raw.startsWith("{") && raw.endsWith("}")) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            if (parsed.answers || parsed.questions || parsed.responses) return true;
            const values = Object.values(parsed);
            if (values.length > 0 && values.every(v => typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
              if (raw.includes("Recommended") || raw.includes("label") || raw.includes("id")) return true;
            }
          }
        }
      } catch {}
      return false;
    });

    const hasUserInputAnswer = Boolean(userInputToolResult);
    const userInputAnswersText = userInputToolResult
      ? formatUserInputAnswers(userInputToolResult.output)
      : undefined;

    const assistantName = input.assistantName || this.options?.assistantName || "Copilot";
    const fullToolProtocol = buildUnifiedToolProtocol(assistantName);

    // 3. Đạo diễn kịch bản hội thoại tự nhiên thông qua ConversationScenarioBuilder
    const scenarioResult = conversationScenarioBuilder.buildTurnPrompt({
      isNewConversation,
      isPlanMode,
      isImplementingPlan,
      hasToolResults,
      hasToolErrors,
      hasUserInputAnswer,
      userInputAnswersText,
      fullToolProtocol,
      actionContractText,
      environmentText,
      developerRulesText,
      systemPromptText: devInstructionsContent,
      priorHistoryText,
      toolResultsText,
      userInstructionText,
      hasImages: Boolean(normalized.images && normalized.images.length > 0),
    });

    let finalPrompt = scenarioResult.finalPrompt;

    // 4. Budget Guard: Cắt tỉa nếu vượt quá ngưỡng an toàn của M365 (95,000 ký tự)
    if (finalPrompt.length > MAX_M365_PROMPT_CHARS) {
      const headLimit = 25_000;
      const tailLimit = MAX_M365_PROMPT_CHARS - headLimit - 200;
      const head = finalPrompt.slice(0, headLimit);
      const tail = finalPrompt.slice(-tailLimit);
      finalPrompt = `${head}\n\n... [Một số ngữ cảnh cũ được rút gọn để tối ưu độ dài cho M365 Copilot] ...\n\n${tail}`;
    }

    console.log(
      `scenario=${scenarioResult.scenario}\n` +
      `planMode=${isPlanMode}\n` +
      `collaborationMode=${collaborationMode}\n` +
      `finalPromptLength=${finalPrompt.length}\n` +
      `mode=${isNewConversation ? "full_handshake" : "incremental_scenario"}`
    );

    const metrics = calculatePromptMetrics({
      toolDeclaration: `${scenarioResult.openingSection}\n\n${actionContractText}`.trim(),
      developerInstructions: devInstructionsContent,
      history: priorHistoryText,
      toolResults: toolResultsText,
      environment: environmentText,
      userRequest: userInstructionText,
      finalPrompt,
    });

    const audit: PromptAuditData = {
      threadId: normalized.threadId,
      turnId: normalized.turnId,
      toolsCount: normalized.activeCodingTools.length,
      developerRulesCount: normalized.developerInstructions?.length || 0,
      historyTurns: normalized.priorHistory.length,
      toolResultsCount: normalized.trailingToolResults.length,
      toolPromptChars: scenarioResult.openingSection.length + actionContractText.length,
      historyChars: priorHistoryText.length,
      developerChars: devInstructionsContent.length,
      environmentChars: environmentText.length,
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

export {
  UNIFIED_TOOL_PROTOCOL_TEMPLATE as UNIFIED_TOOL_PROTOCOL,
  MINIMAL_TOOL_PROTOCOL_TEMPLATE as MINIMAL_TOOL_PROTOCOL,
};
