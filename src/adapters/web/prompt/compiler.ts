
import type { CodexParsedRequest } from "../../../types";
import type { NormalizedCodexRequest, NormalizedTool } from "../normalization/canonical-types";
import {
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  TOOL_REMINDER_PROMPT,
  buildStructuredJsonOutputProtocol,
  buildUnifiedToolProtocol,
  UNIFIED_TOOL_PROTOCOL as UNIFIED_TOOL_PROTOCOL_TEMPLATE,
  MINIMAL_TOOL_PROTOCOL as MINIMAL_TOOL_PROTOCOL_TEMPLATE,
  SHORT_OUTPUT_FORMAT_ANCHOR,
  SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
  formatUserInputAnswers,
} from "./templates";
import { conversationScenarioBuilder, type ConversationScenario } from "./conversation-scenario-builder";
import { sanitizeCodexBoilerplate } from "../normalization/instruction-sanitizer";
import { WebToolRegistry } from "../tools/web-tool-registry";
import {
  mcpToolCatalogRenderer,
  type McpToolDeltaOptions,
} from "./mcp-tool-catalog-renderer";
import { hasActualPriorAssistantReply } from "../../base";
import {
  personalizationPromptBuilder,
  personalizationStore,
} from "../../../personalization";

export const DEFAULT_MAX_WEB_PROMPT_CHARS = 95_000;

/**
 * Loại bỏ instruction nội bộ của Codex khỏi prompt gửi sang web model.
 * Dùng chung bộ sanitize chuẩn với CodexPayloadNormalizer.
 */
export function sanitizeCodexInstructions(text: string): string {
  return sanitizeCodexBoilerplate(text);
}

/**
 * Thực hiện xử lý truncateToolResult cho quy trình M365 Copilot Adapter.
 */
export function truncateToolResult(content: string, maxChars?: number): string {

  if (!maxChars || content.length <= maxChars) return content;
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
  return WebToolRegistry.cleanDescription(name, rawDesc);
}

/**
 * Render MCP Tool Catalog cho Turn 1 (Core inline schema + Extended catalog 1 dòng + tools.describe).
 */
export function renderDynamicToolDeclarations(
  tools: NormalizedTool[] = [],
  assistantName: string = "trợ lý web",
  deferredNamespaces: string[] = [],
): string {
  return mcpToolCatalogRenderer.renderInitialCatalog({
    tools,
    assistantName,
    deferredNamespaces,
  });
}

/**
 * Render bản tóm tắt tên tool không kèm ví dụ dài dòng (chỉ dùng cho trường hợp cần liệt kê nhanh).
 */
export function renderCompactDynamicToolDeclarations(tools: NormalizedTool[] = []): string {
  if (tools.length === 0) {
    return "[MCP TOOL CATALOG (RÚT GỌN)]: Hiện không có công cụ nào khả dụng.";
  }

  const summary = tools.map(tool => {
    const wireName = tool.identity.qualifiedName || tool.identity.name;
    return `- ${wireName} [${tool.kind === "custom" ? "freeform" : "function"}] — ${WebToolRegistry.getCuratedDescription(tool, true)}`;
  }).join("\n");

  return `[MCP TOOL CATALOG (RÚT GỌN)]\n${summary}`;
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
  maxPromptChars?: number;
  toolDelta?: McpToolDeltaOptions;
  includeEnvironment?: boolean;
  includeUserInstruction?: boolean;
  includePersonalization?: boolean;
  personalizationText?: string;
  workspaceMemoryHintText?: string;
}

export interface PromptCompileResult {
  finalPrompt: string;
  metrics: PromptSectionMetrics;
  audit: PromptAuditData;
  collaborationMode: "default" | "plan";
  isPlanMode: boolean;
  isImplementingPlan: boolean;
  scenario: ConversationScenario;
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

export function isStructuredJsonOutputTurn(
  parsed?: CodexParsedRequest,
  hasToolResults = false,
): boolean {
  return parsed?.options?.outputFormat?.type === "json_schema" && !hasToolResults;
}

/**
 * Nhận diện kết quả tool `apply_patch` bị từ chối khi verify hunk / context lines.
 */
export function isApplyPatchVerificationError(result: {
  toolName?: string;
  output: string;
}): boolean {
  const output = result.output.trim();
  if (!output) return false;
  return (
    /^apply_patch verification failed\b/im.test(output) ||
    /^apply_patch\b[^\n]*\bfailed\b/im.test(output) ||
    (result.toolName === "apply_patch" &&
      (/Failed to find expected lines\b/i.test(output) ||
        /invalid hunk\b/i.test(output) ||
        /^Error:/i.test(output)))
  );
}

/**
 * Nhận diện kết quả thực thi công cụ thất bại từ Codex để kích hoạt TOOL_ERROR_FEEDBACK.
 */
export function isToolResultError(result: {
  toolName?: string;
  output: string;
}): boolean {
  if (isApplyPatchVerificationError(result)) return true;
  const output = result.output;
  return (
    /Process exited with code [1-9]\d*/.test(output) ||
    /[Ee]xit code:\s*[1-9]\d*/.test(output) ||
    output.startsWith("Error:") ||
    output.startsWith("Lỗi:") ||
    output.includes("Command failed:")
  );
}

export interface WebPromptCompilerOptions {
  assistantName?: string;
  maxPromptChars?: number;
}

/**
 * Trình biên dịch Prompt dùng chung cho toàn bộ Web Adapter (Unified Web Prompt Compiler).
 * Tham số hóa tên trợ lý và ngưỡng độ dài tối đa theo từng provider.
 */
export class WebPromptCompiler {
  constructor(readonly options?: WebPromptCompilerOptions) {}

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

    const assistantName = input.assistantName || this.options?.assistantName || "Copilot";
    const maxPromptChars = input.maxPromptChars ?? this.options?.maxPromptChars ?? DEFAULT_MAX_WEB_PROMPT_CHARS;
    const structuredOutputFormat = isStructuredJsonOutputTurn(parsed, hasToolResults)
      ? parsed?.options?.outputFormat
      : undefined;

    // 2. Chuẩn bị các thành phần nội dung ngữ cảnh đã được làm sạch
    const actionContractText = structuredOutputFormat
      ? ""
      : isNewConversation
        ? mcpToolCatalogRenderer.renderInitialCatalog({
            tools: normalized.activeCodingTools,
            deferredNamespaces: normalized.deferredNamespaces,
            assistantName,
          })
        : input.toolDelta
          ? mcpToolCatalogRenderer.renderToolDelta(input.toolDelta)
          : "";

    let environmentText = "";
    if (normalized.environmentContext) {
      environmentText = `[Thư mục làm việc trên máy mình]:\n${normalized.environmentContext}`;
    }

    let systemInstructionsContent = "";
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
        systemInstructionsContent = `[Chỉ dẫn từ hệ thống]:\n${filteredSystem}`;
      }
    }

    let developerRulesText = "";
    if (!structuredOutputFormat && normalized.developerInstructions && normalized.developerInstructions.length > 0) {
      const cleanedRules = normalized.developerInstructions
        .map(r => sanitizeCodexInstructions(r))
        .filter(r => r.length > 0);
      if (cleanedRules.length > 0) {
        const devRules = cleanedRules
          .map(r => (r.startsWith("-") || r.startsWith("*") || r.startsWith("#") || r.includes("\n")) ? r : `- ${r}`)
          .join("\n\n");
        developerRulesText = `[Một số quy ước làm việc trong dự án của mình]:\n${devRules}`;
      }
    }

    const combinedDeveloperChars =
      systemInstructionsContent.length +
      (developerRulesText ? (systemInstructionsContent ? 2 : 0) + developerRulesText.length : 0);

    let priorHistoryText = "";
    if (isNewConversation && normalized.priorHistory.length > 0) {
      const historyLines: string[] = [];
      for (const h of normalized.priorHistory) {
        if (h.role === "user") {
          historyLines.push(`Người dùng: ${h.content}`);
        } else if (h.role === "assistant") {
          historyLines.push(`Trợ lý: ${h.content}`);
        } else if (h.role === "tool") {
          historyLines.push(`<tool_result id="${h.callId || ""}">\n${h.content}\n</tool_result>`);
        }
      }
      if (historyLines.length > 0) {
        priorHistoryText = `[Lịch sử trao đổi trước đó]:\n${historyLines.join("\n\n")}`;
      }
    }

    let toolResultsText = "";
    if (normalized.trailingToolResults.length > 0) {
      const resultBlocks = normalized.trailingToolResults.map(res => {
        const content = res.output;
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

    const hasApplyPatchError = normalized.trailingToolResults.some(
      isApplyPatchVerificationError,
    );
    const hasToolErrors =
      hasApplyPatchError || normalized.trailingToolResults.some(isToolResultError);

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

    const structuredJsonOutputProtocol = structuredOutputFormat
      ? buildStructuredJsonOutputProtocol({
          assistantName,
          schemaName: structuredOutputFormat.name,
          strict: structuredOutputFormat.strict,
          schema: structuredOutputFormat.schema,
        })
      : undefined;

    const fullToolProtocol = structuredOutputFormat
      ? ""
      : buildUnifiedToolProtocol(assistantName);

    const includeEnvironment = input.includeEnvironment ?? (isNewConversation || !hasToolResults);
    const includeUserInstruction = input.includeUserInstruction ?? true;
    const includePersonalization = input.includePersonalization ?? true;

    let personalizationText = "";
    let workspaceMemoryHintText = "";
    if (!structuredOutputFormat && includePersonalization) {
      const needGlobalFallback = input.personalizationText === undefined && isNewConversation;
      const needWorkspaceFallback = input.workspaceMemoryHintText === undefined;
      const fallbackSnapshot =
        needGlobalFallback || needWorkspaceFallback
          ? personalizationStore.getSnapshot()
          : undefined;

      personalizationText =
        input.personalizationText !== undefined
          ? input.personalizationText
          : needGlobalFallback && fallbackSnapshot
            ? personalizationPromptBuilder.buildGlobalSection(fallbackSnapshot.settings)
            : "";

      workspaceMemoryHintText =
        input.workspaceMemoryHintText !== undefined
          ? input.workspaceMemoryHintText
          : needWorkspaceFallback && fallbackSnapshot
            ? personalizationPromptBuilder.buildWorkspaceMemoryHint(
                normalized.workspaceCwd,
                fallbackSnapshot.settings.enabled &&
                  fallbackSnapshot.settings.workspaceMemoryEnabled,
              )
            : "";
    }

    // 3. Đạo diễn kịch bản hội thoại tự nhiên thông qua ConversationScenarioBuilder
    const buildScenario = (historyOverride: string) =>
      conversationScenarioBuilder.buildTurnPrompt({
        isStructuredJsonOutput: Boolean(structuredOutputFormat),
        structuredJsonOutputProtocol,
        isNewConversation,
        isPlanMode,
        isImplementingPlan,
        hasToolResults,
        hasToolErrors,
        hasApplyPatchError,
        hasUserInputAnswer,
        userInputAnswersText,
        includeEnvironment,
        includeUserInstruction,
        fullToolProtocol,
        actionContractText,
        environmentText,
        developerRulesText,
        personalizationText,
        workspaceMemoryHintText,
        systemPromptText: systemInstructionsContent,
        priorHistoryText: historyOverride,
        toolResultsText,
        userInstructionText,
        hasImages: Boolean(normalized.images && normalized.images.length > 0),
      });

    let scenarioResult = buildScenario(priorHistoryText);
    let finalPrompt = scenarioResult.finalPrompt;

    // 4. Budget Guard: Ưu tiên rút gọn lịch sử cũ trước để giữ nguyên Personalization & yêu cầu hiện tại
    if (finalPrompt.length > maxPromptChars && priorHistoryText.length > 0) {
      const overflow = finalPrompt.length - maxPromptChars + 160;
      const allowedHistoryChars = Math.max(0, priorHistoryText.length - overflow);
      const trimmedHistory =
        allowedHistoryChars > 240
          ? `... [Một số lịch sử trao đổi cũ được rút gọn để tối ưu độ dài] ...\n\n${priorHistoryText.slice(-allowedHistoryChars)}`
          : "";
      scenarioResult = buildScenario(trimmedHistory);
      finalPrompt = scenarioResult.finalPrompt;
    }

    if (finalPrompt.length > maxPromptChars) {
      const headLimit = Math.min(25_000, Math.floor(maxPromptChars * 0.3));
      const tailLimit = Math.max(0, maxPromptChars - headLimit - 200);
      const head = finalPrompt.slice(0, headLimit);
      const tail = tailLimit > 0 ? finalPrompt.slice(-tailLimit) : "";
      finalPrompt = `${head}\n\n... [Một số ngữ cảnh cũ được rút gọn để tối ưu độ dài cho ${assistantName}] ...\n\n${tail}`;
    }

    console.log(
      `scenario=${scenarioResult.scenario}\n` +
      `planMode=${isPlanMode}\n` +
      `collaborationMode=${collaborationMode}\n` +
      `finalPromptLength=${finalPrompt.length}\n` +
      `mode=${isNewConversation ? "full_handshake" : "incremental_scenario"}`
    );

    const combinedDevText = [systemInstructionsContent, developerRulesText].filter(Boolean).join("\n\n");
    const effectiveEnvText = includeEnvironment ? environmentText : "";
    const effectiveUserText = includeUserInstruction ? userInstructionText : "";

    const metrics = calculatePromptMetrics({
      toolDeclaration: `${scenarioResult.openingSection}\n\n${actionContractText}`.trim(),
      developerInstructions: combinedDevText,
      history: priorHistoryText,
      toolResults: toolResultsText,
      environment: effectiveEnvText,
      userRequest: effectiveUserText,
      finalPrompt,
    });

    const audit: PromptAuditData = {
      threadId: normalized.threadId,
      turnId: normalized.turnId,
      toolsCount: normalized.activeCodingTools.length,
      developerRulesCount: structuredOutputFormat ? 0 : (normalized.developerInstructions?.length || 0),
      historyTurns: normalized.priorHistory.length,
      toolResultsCount: normalized.trailingToolResults.length,
      toolPromptChars: scenarioResult.openingSection.length + actionContractText.length,
      historyChars: priorHistoryText.length,
      developerChars: combinedDeveloperChars,
      environmentChars: effectiveEnvText.length,
      finalPromptChars: finalPrompt.length,
    };

    return {
      finalPrompt,
      metrics,
      audit,
      collaborationMode,
      isPlanMode,
      isImplementingPlan,
      scenario: scenarioResult.scenario,
    };
  }
}

export const promptCompiler = new WebPromptCompiler();

export {
  UNIFIED_TOOL_PROTOCOL_TEMPLATE as UNIFIED_TOOL_PROTOCOL,
  MINIMAL_TOOL_PROTOCOL_TEMPLATE as MINIMAL_TOOL_PROTOCOL,
};
