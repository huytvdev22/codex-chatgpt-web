import type { CodexParsedRequest } from "../../../../types";
import type { IPromptAssembler } from "../contracts/iprompt-assembler";
import {
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
} from "../templates/plan-mode.template";
import {
  TOOL_REMINDER_PROMPT,
  TOOL_RESULT_HINTS,
} from "../templates/tool-reminder.template";
import {
  UNIFIED_TOOL_PROTOCOL,
} from "../templates/system-protocol.template";
import {
  MANDATORY_4_BACKTICK_MARKDOWN_PROMPT,
  MANDATORY_4_BACKTICK_PLAN_MODE_PROMPT,
  OUTPUT_FORMAT_HINTS,
} from "../templates/output-format.template";
import { PromptSanitizer, MAX_WEB_PROMPT_CHARS } from "./prompt-sanitizer";
import { PlanModeDetector } from "./plan-mode-detector";

export class BasePromptAssembler implements IPromptAssembler {
  protected maxPromptChars: number = MAX_WEB_PROMPT_CHARS;

  assemble(parsed: CodexParsedRequest, isNewConversation = true): string {
    const parts: string[] = [];
    const isImplementingPlan = PlanModeDetector.isImplementingPlanRequest(parsed);
    const isPlanMode = !isImplementingPlan && PlanModeDetector.isPlanModeRequest(parsed);

    const allMessages = parsed.context.messages || [];
    let messages = allMessages;

    if (!isNewConversation) {
      const lastAssistantIdx = allMessages.findLastIndex(msg => msg.role === "assistant");
      if (lastAssistantIdx >= 0) {
        if (lastAssistantIdx < allMessages.length - 1) {
          messages = allMessages.slice(lastAssistantIdx + 1);
        } else {
          messages = [];
        }
      }
    }

    // 1. Thu thập Developer & System Prompts
    if (isNewConversation && parsed.context.systemPrompt && parsed.context.systemPrompt.length > 0) {
      const filteredSystem = parsed.context.systemPrompt
        .map(sp => sp.trim())
        .filter(
          sp =>
            sp.length > 0 &&
            !sp.startsWith("<environment_context>") &&
            !sp.includes("spawn_agent") &&
            !sp.includes("You are Codex, a coding assistant")
        )
        .join("\n\n");
      if (filteredSystem) {
        parts.push(`[System Instructions]:\n${filteredSystem}`);
      }
    }

    if (isPlanMode) {
      parts.push(PLAN_MODE_PROMPT);
    } else if (isImplementingPlan) {
      parts.push(IMPLEMENT_PLAN_PROMPT);
    }

    const hasToolResultInTurn = messages.some(m => m.role === "toolResult");
    if (!hasToolResultInTurn) {
      parts.push(`[Tool Instructions]:\n${UNIFIED_TOOL_PROTOCOL}`);
    } else {
      parts.push(`[Tool Instructions]:\n${TOOL_REMINDER_PROMPT}`);
    }

    // 2. Thu thập Messages theo thứ tự thời gian
    for (const msg of messages) {
      if (msg.role === "developer") {
        let text = PromptSanitizer.stringifyContent(msg.content);
        text = text
          .replace(/<codex_apps_client_time_context>[\s\S]*?<\/codex_apps_client_time_context>/gi, "")
          .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/gi, "")
          .replace(/<codex_apps_open_page_instructions>[\s\S]*?<\/codex_apps_open_page_instructions>/gi, "")
          .trim();
        if (
          text.length > 0 &&
          text.length < 2000 &&
          !text.includes("<skills_instructions>") &&
          !text.includes("You are Codex, a coding assistant")
        ) {
          parts.push(`[Context]: ${text}`);
        }
      } else if (msg.role === "user") {
        let text = PromptSanitizer.stringifyContent(msg.content);
        text = text
          .replace(/<codex_apps_client_time_context>[\s\S]*?<\/codex_apps_client_time_context>/gi, "")
          .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/gi, "")
          .replace(/<codex_apps_open_page_instructions>[\s\S]*?<\/codex_apps_open_page_instructions>/gi, "")
          .trim();
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
        const text = PromptSanitizer.stringifyContent(msg.content);
        if (text) {
          const safeText = PromptSanitizer.truncateToolResult(text);
          const isFenced = safeText.startsWith("```");
          const safeBody = isFenced ? safeText : `\`\`\`\n${safeText}\n\`\`\``;
          if (isPlanMode) {
            parts.push(`<tool_result>\n${safeBody}\n</tool_result>\n${TOOL_RESULT_HINTS.planMode}`);
          } else if (isImplementingPlan) {
            parts.push(`<tool_result>\n${safeBody}\n</tool_result>\n${TOOL_RESULT_HINTS.implementPlan}`);
          } else {
            parts.push(`<tool_result>\n${safeBody}\n</tool_result>\n${TOOL_RESULT_HINTS.default}`);
          }
        }
      }
    }

    if (!hasToolResultInTurn && parts.length > 0) {
      if (isPlanMode) {
        parts.push(OUTPUT_FORMAT_HINTS.planMode);
      } else if (isImplementingPlan) {
        parts.push(OUTPUT_FORMAT_HINTS.implementPlan);
      } else {
        parts.push(OUTPUT_FORMAT_HINTS.default);
      }
    }

    const formatPrompt = isPlanMode ? MANDATORY_4_BACKTICK_PLAN_MODE_PROMPT : MANDATORY_4_BACKTICK_MARKDOWN_PROMPT;
    parts.push(formatPrompt);

    let finalPrompt = parts.join("\n\n").trim();

    if (finalPrompt.length > this.maxPromptChars) {
      const headLimit = 15_000;
      const tailLimit = this.maxPromptChars - headLimit - 200;
      const head = finalPrompt.slice(0, headLimit);
      const tail = finalPrompt.slice(-tailLimit);
      finalPrompt = `${head}\n\n... [Một số ngữ cảnh cũ được rút gọn để tối ưu độ dài] ...\n\n${tail}`;
    }

    return finalPrompt;
  }
}
