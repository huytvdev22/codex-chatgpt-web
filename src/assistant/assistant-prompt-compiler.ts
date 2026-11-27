import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../types";
import type { NormalizedCodexRequest } from "../adapters/web/normalization/canonical-types";
import { sanitizeCodexBoilerplate } from "../adapters/web/normalization/instruction-sanitizer";
import {
  isApplyPatchVerificationError,
  isStructuredJsonOutputTurn,
  isToolResultError,
} from "../adapters/web/prompt/compiler";
import { formatUserInputAnswers } from "../adapters/web/prompt/templates";
import type { McpToolDeltaOptions } from "../adapters/web/prompt/mcp-tool-catalog-renderer";
import { skillPromptBuilder } from "../skills/skill-prompt-builder";
import type { HostSkillEntry, SelectedSkillEntry, SkillsSettings } from "../skills/types";
import {
  ASSISTANT_IMAGE_ATTACHMENT_HINT,
  ASSISTANT_TOOL_ERROR_HEADER,
  ASSISTANT_TOOL_RESULT_HEADER,
  ASSISTANT_USER_INPUT_HEADER,
  buildAssistantProtocol,
  buildAssistantStructuredJsonProtocol,
} from "./assistant-prompt-templates";
import { assistantToolCatalogRenderer } from "./assistant-tool-catalog-renderer";
import type { AssistantPromptCompileResult, AssistantPromptScenario } from "./types";

const DEFAULT_ASSISTANT_MAX_PROMPT_CHARS = 95_000;

/**
 * Cấu hình lọc skill tĩnh cho Assistant:
 * chỉ chấp nhận skill do chính `1.codex-assistant` gửi lên, tắt hoàn toàn `system` skills
 * của Codex (`imagegen`, `openai-docs`, `skill-creator`, `skill-installer`) để tránh nhiễu và trùng tên.
 */
const ASSISTANT_SKILLS_FILTER_SETTINGS: SkillsSettings = {
  version: 1,
  enabled: true,
  autoDiscoverHostSkills: true,
  includeSystemSkills: false,
  disabledSkills: [],
  skillDirectories: [],
  updatedAt: null,
};

export interface AssistantPromptCompileInput {
  normalized: NormalizedCodexRequest;
  parsed?: CodexParsedRequest;
  assistantName?: string;
  isNewConversation: boolean;
  maxPromptChars?: number;
  toolDelta?: McpToolDeltaOptions;
  includeEnvironment?: boolean;
  includeUserInstruction?: boolean;
  includeAvailableSkills?: boolean;
  includeSelectedSkills?: boolean;
}

/**
 * Trình biên dịch Prompt độc lập cho Trợ lý cá nhân (`src/assistant/`):
 * - KHÔNG đọc Global Personalization của Codex lập trình.
 * - KHÔNG bơm gợi ý `.codex-copilot/MEMORY.md`.
 * - KHÔNG quét thư mục skill của VS Code (`~/.codex/skills`, `~/.gemini/config/skills`).
 * - Lọc bỏ mặc định 4 `.system` skills của Codex CLI và nén gọn Tool Catalog.
 */
export class AssistantPromptCompiler {
  public filterAssistantSkills(
    hostSkills: readonly HostSkillEntry[] | undefined,
  ): HostSkillEntry[] {
    if (!hostSkills || hostSkills.length === 0) return [];
    return skillPromptBuilder.filterHostSkills(
      hostSkills,
      ASSISTANT_SKILLS_FILTER_SETTINGS,
    );
  }

  public computeSkillsDigests(normalized: NormalizedCodexRequest): {
    filteredSkills: HostSkillEntry[];
    selectedSkills: SelectedSkillEntry[];
    availableSkillsDigest: string;
    selectedSkillsDigest: string;
  } {
    const filteredSkills = this.filterAssistantSkills(normalized.availableSkills);
    const selectedSkills = skillPromptBuilder.resolveExplicitSkillMentions(
      normalized.latestUserInstruction,
      filteredSkills,
      normalized.selectedSkills,
      ASSISTANT_SKILLS_FILTER_SETTINGS,
    );
    const availableSkillsDigest =
      filteredSkills.length > 0
        ? createHash("sha256")
            .update(
              JSON.stringify(
                filteredSkills.map((s) => ({ name: s.name, path: s.absolutePath })),
              ),
            )
            .digest("hex")
            .slice(0, 16)
        : "";
    const selectedSkillsDigest =
      selectedSkills.length > 0
        ? createHash("sha256")
            .update(JSON.stringify(selectedSkills))
            .digest("hex")
            .slice(0, 16)
        : "";
    return {
      filteredSkills,
      selectedSkills,
      availableSkillsDigest,
      selectedSkillsDigest,
    };
  }

  public compile(input: AssistantPromptCompileInput): AssistantPromptCompileResult {
    const { normalized, parsed, isNewConversation } = input;
    const assistantName = input.assistantName || "trợ lý";
    const maxPromptChars = input.maxPromptChars ?? DEFAULT_ASSISTANT_MAX_PROMPT_CHARS;
    const hasToolResults = normalized.trailingToolResults.length > 0;
    const structuredFormat = isStructuredJsonOutputTurn(parsed, hasToolResults)
      ? parsed?.options?.outputFormat
      : undefined;

    if (structuredFormat) {
      const sections: string[] = [
        buildAssistantStructuredJsonProtocol({
          schemaName: structuredFormat.name,
          strict: structuredFormat.strict,
          schema: structuredFormat.schema,
        }),
      ];
      if (normalized.latestUserInstruction) {
        sections.push(`[Yêu cầu]:\n${normalized.latestUserInstruction}`);
      }
      if (normalized.images && normalized.images.length > 0) {
        sections.push(ASSISTANT_IMAGE_ATTACHMENT_HINT);
      }
      return {
        scenario: "STRUCTURED_JSON_OUTPUT",
        finalPrompt: sections.filter(Boolean).join("\n\n").trim(),
      };
    }

    const userInputToolResult = normalized.trailingToolResults.find((res) => {
      if (
        res.toolName === "request_user_input" ||
        res.callId.toLowerCase().includes("request_user_input")
      ) {
        return true;
      }
      return false;
    });
    const hasUserInputAnswer = Boolean(userInputToolResult);
    const hasToolErrors =
      normalized.trailingToolResults.some(isApplyPatchVerificationError) ||
      normalized.trailingToolResults.some(isToolResultError);

    const scenario: AssistantPromptScenario = isNewConversation
      ? "FIRST_HANDSHAKE"
      : hasUserInputAnswer
        ? "USER_INPUT_ANSWER"
        : hasToolResults
          ? hasToolErrors
            ? "TOOL_ERROR_FEEDBACK"
            : "TOOL_RESULT_CONTINUATION"
          : "CONVERSATION";

    const toolCatalogText = isNewConversation
      ? assistantToolCatalogRenderer.renderInitialCatalog({
          tools: normalized.activeCodingTools,
          deferredNamespaces: normalized.deferredNamespaces,
        })
      : input.toolDelta
        ? assistantToolCatalogRenderer.renderToolDelta(input.toolDelta)
        : "";

    const environmentText =
      (input.includeEnvironment ?? (isNewConversation || !hasToolResults)) &&
      normalized.environmentContext
        ? `[Môi trường]:\n${normalized.environmentContext}`
        : "";

    let developerRulesText = "";
    if (isNewConversation && normalized.developerInstructions?.length) {
      const cleanedRules = normalized.developerInstructions
        .map((rule) => sanitizeCodexBoilerplate(rule))
        .filter((rule) => rule.length > 0);
      if (cleanedRules.length > 0) {
        developerRulesText = `[Hướng dẫn & Bộ nhớ Trợ lý]:\n${cleanedRules.join("\n\n")}`;
      }
    }

    const { filteredSkills, selectedSkills } = this.computeSkillsDigests(normalized);
    const availableSkillsText =
      (input.includeAvailableSkills ?? isNewConversation) && filteredSkills.length > 0
        ? [
            "[Skills khả dụng (đọc SKILL.md khi cần dùng hoặc khi có $tên-skill)]:",
            ...filteredSkills.map((s) => `- ${s.name} -> ${s.absolutePath}`),
          ].join("\n")
        : "";
    const selectedSkillsText =
      (input.includeSelectedSkills ?? true) && selectedSkills.length > 0
        ? skillPromptBuilder.buildSelectedSkillsSection(
            selectedSkills,
            ASSISTANT_SKILLS_FILTER_SETTINGS,
          )
        : "";

    let priorHistoryText = "";
    if (isNewConversation && normalized.priorHistory.length > 0) {
      const historyLines: string[] = [];
      for (const h of normalized.priorHistory) {
        if (h.role === "user") historyLines.push(`Người dùng: ${h.content}`);
        else if (h.role === "assistant") historyLines.push(`Trợ lý: ${h.content}`);
        else if (h.role === "tool") {
          historyLines.push(`<tool_result id="${h.callId || ""}">\n${h.content}\n</tool_result>`);
        }
      }
      if (historyLines.length > 0) {
        priorHistoryText = `[Lịch sử trước đó]:\n${historyLines.join("\n\n")}`;
      }
    }

    let toolResultsText = "";
    if (hasToolResults) {
      const blocks = normalized.trailingToolResults.map((res) => {
        const body = res.output.startsWith("```")
          ? res.output
          : `\`\`\`\n${res.output}\n\`\`\``;
        return `<tool_result id="${res.callId}">\n${body}\n</tool_result>`;
      });
      toolResultsText = blocks.join("\n\n");
    }

    const userInstructionText =
      (input.includeUserInstruction ?? true) && normalized.latestUserInstruction
        ? `[Yêu cầu hiện tại]:\n${normalized.latestUserInstruction}`
        : "";

    const buildBody = (historyOverride: string): string => {
      const parts: string[] = [];
      if (scenario === "FIRST_HANDSHAKE") {
        parts.push(buildAssistantProtocol(assistantName));
        if (toolCatalogText) parts.push(toolCatalogText);
        if (environmentText) parts.push(environmentText);
        if (developerRulesText) parts.push(developerRulesText);
        if (availableSkillsText) parts.push(availableSkillsText);
        if (historyOverride) parts.push(historyOverride);
        if (toolResultsText) parts.push(toolResultsText);
        if (selectedSkillsText) parts.push(selectedSkillsText);
        if (userInstructionText) parts.push(userInstructionText);
      } else {
        if (scenario === "USER_INPUT_ANSWER" && userInputToolResult) {
          parts.push(
            `${ASSISTANT_USER_INPUT_HEADER}\n${formatUserInputAnswers(userInputToolResult.output)}`,
          );
        } else if (scenario === "TOOL_ERROR_FEEDBACK") {
          parts.push(ASSISTANT_TOOL_ERROR_HEADER);
        } else if (scenario === "TOOL_RESULT_CONTINUATION") {
          parts.push(ASSISTANT_TOOL_RESULT_HEADER);
        }
        if (environmentText) parts.push(environmentText);
        if (availableSkillsText) parts.push(availableSkillsText);
        if (toolCatalogText) parts.push(toolCatalogText);
        if (toolResultsText) parts.push(toolResultsText);
        if (selectedSkillsText) parts.push(selectedSkillsText);
        if (userInstructionText) parts.push(userInstructionText);
      }

      if (normalized.images && normalized.images.length > 0) {
        parts.push(ASSISTANT_IMAGE_ATTACHMENT_HINT);
      }
      return parts.filter(Boolean).join("\n\n").trim();
    };

    let finalPrompt = buildBody(priorHistoryText);
    if (finalPrompt.length > maxPromptChars && priorHistoryText.length > 0) {
      const overflow = finalPrompt.length - maxPromptChars + 140;
      const allowedHistoryChars = Math.max(0, priorHistoryText.length - overflow);
      const trimmedHistory =
        allowedHistoryChars > 240
          ? `... [Rút gọn lịch sử cũ] ...\n\n${priorHistoryText.slice(-allowedHistoryChars)}`
          : "";
      finalPrompt = buildBody(trimmedHistory);
    }
    if (finalPrompt.length > maxPromptChars) {
      const headLimit = Math.min(20_000, Math.floor(maxPromptChars * 0.3));
      const tailLimit = Math.max(0, maxPromptChars - headLimit - 160);
      finalPrompt = `${finalPrompt.slice(0, headLimit)}\n\n... [Rút gọn ngữ cảnh] ...\n\n${finalPrompt.slice(-tailLimit)}`;
    }

    return {
      scenario,
      finalPrompt,
    };
  }
}

export const assistantPromptCompiler = new AssistantPromptCompiler();
