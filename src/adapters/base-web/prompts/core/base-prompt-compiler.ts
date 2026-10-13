import type { IPromptCompiler } from "../contracts/iprompt-compiler";
import type { PromptCompileInput } from "../dto/prompt-compile-input.dto";
import type { PromptCompileResult } from "../dto/prompt-compile-result.dto";
import type { PromptAuditData } from "../dto/prompt-audit.dto";
import type { NormalizedToolResult } from "../../normalization";
import { calculatePromptMetrics } from "../dto/prompt-metrics.dto";
import {
  UNIFIED_TOOL_PROTOCOL,
} from "../templates/system-protocol.template";
import {
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
} from "../templates/plan-mode.template";
import {
  TOOL_REMINDER_PROMPT,
  TOOL_RESULT_HINTS,
} from "../templates/tool-reminder.template";
import {
  STRICT_ACTIONS_TOLERANT_ANSWERS_PROMPT,
  STRICT_ACTIONS_TOLERANT_ANSWERS_PLAN_PROMPT,
  SHORT_OUTPUT_FORMAT_ANCHOR,
  SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
} from "../templates/output-format.template";
import { WEB_IMAGE_ATTACHMENT_HINT } from "../templates/attachment.template";
import { ToolDeclarationRenderer } from "./tool-declaration-renderer";
import { PromptSanitizer, MAX_WEB_PROMPT_CHARS } from "./prompt-sanitizer";
import { PlanModeDetector } from "./plan-mode-detector";

export class BasePromptCompiler implements IPromptCompiler {
  protected maxPromptChars: number = MAX_WEB_PROMPT_CHARS;

  compile(input: PromptCompileInput): PromptCompileResult {
    const { normalized, parsed } = input;

    // 1. Phân định chính xác Collaboration Mode
    const isImplementingPlan = input.isImplementingPlan !== undefined
      ? input.isImplementingPlan
      : PlanModeDetector.isImplementingPlanRequest(parsed);

    const collaborationMode: "default" | "plan" = isImplementingPlan
      ? "default"
      : (normalized.collaborationMode || "default");

    const isPlanMode = !isImplementingPlan && collaborationMode === "plan";
    const isNewConversation = input.isNewConversation ?? true;

    // -------------------------------------------------------------
    // CHẾ ĐỘ INCREMENTAL ROUNDTRIP (STATEFUL MODE - LƯỢT TIẾP THEO)
    // -------------------------------------------------------------
    if (!isNewConversation) {
      const incrementalSections: string[] = [];

      // 1. Lời nhắc vai trò thực thi công cụ IDE
      const reminderSection = isImplementingPlan
        ? `${IMPLEMENT_PLAN_PROMPT}\n\n${TOOL_REMINDER_PROMPT}`
        : (isPlanMode ? `${PLAN_MODE_PROMPT}\n\n${TOOL_REMINDER_PROMPT}` : TOOL_REMINDER_PROMPT);
      incrementalSections.push(
        [
          "================================================================================",
          "# THỰC THI NHIỆM VỤ TIẾP THEO (STATEFUL INCREMENTAL TURN)",
          "================================================================================",
          reminderSection,
        ].join("\n")
      );

      // 2. Bảo toàn Ngữ cảnh Môi trường / Thư mục làm việc
      let envSection = "";
      if (normalized.environmentContext) {
        envSection = `[NGỮ CẢNH DỰ ÁN & MÔI TRƯỜNG]:\n${normalized.environmentContext}`;
        incrementalSections.push(envSection);
      }

      // 3. Danh sách tools phiên bản COMPACT
      const compactToolsText = ToolDeclarationRenderer.renderCompactDynamicToolDeclarations(normalized.activeCodingTools);
      incrementalSections.push(compactToolsText);

      // 4. Kết quả công cụ gần nhất
      let toolResultsContent = "";
      if (normalized.trailingToolResults.length > 0) {
        const resultBlocks = normalized.trailingToolResults.map((res: NormalizedToolResult) => {
          const content = PromptSanitizer.truncateToolResult(res.output);
          const isFenced = content.startsWith("```");
          const safeBody = isFenced ? content : `\`\`\`\n${content}\n\`\`\``;
          return `<tool_result id="${res.callId}">\n${safeBody}\n</tool_result>`;
        });
        const hint = isPlanMode
          ? TOOL_RESULT_HINTS.planMode
          : (isImplementingPlan ? TOOL_RESULT_HINTS.implementPlan : TOOL_RESULT_HINTS.default);
        toolResultsContent = `[KẾT QUẢ THỰC THI CÔNG CỤ VỪA NHẬN ĐƯỢC TỪ IDE]:\n${resultBlocks.join("\n\n")}\n\n${hint}`;
        incrementalSections.push(toolResultsContent);
      }

      // 5. Yêu cầu người dùng (nếu có)
      let userReqContent = "";
      if (normalized.latestUserInstruction) {
        userReqContent = `[YÊU CẦU CỦA NGƯỜI DÙNG]:\n${normalized.latestUserInstruction}`;
        incrementalSections.push(userReqContent);
      }

      // 6. Thông báo hình ảnh đính kèm (nếu có)
      if (normalized.images && normalized.images.length > 0) {
        incrementalSections.push(WEB_IMAGE_ATTACHMENT_HINT);
      }

      // 7. Lời nhắc định dạng đầu ra ở cuối cùng
      let outputAnchorPrompt = isPlanMode
        ? SHORT_OUTPUT_FORMAT_PLAN_ANCHOR
        : SHORT_OUTPUT_FORMAT_ANCHOR;
      if (isImplementingPlan) {
        outputAnchorPrompt = `${outputAnchorPrompt}\n\n${STRICT_ACTIONS_TOLERANT_ANSWERS_PROMPT}`;
      }
      incrementalSections.push(outputAnchorPrompt);

      let finalPrompt = incrementalSections.join("\n\n").trim();

      if (finalPrompt.length > this.maxPromptChars) {
        const headLimit = 25_000;
        const tailLimit = this.maxPromptChars - headLimit - 200;
        const head = finalPrompt.slice(0, headLimit);
        const tail = finalPrompt.slice(-tailLimit);
        finalPrompt = `${head}\n\n... [Một số ngữ cảnh cũ được rút gọn để tối ưu độ dài] ...\n\n${tail}`;
      }

      console.log(
        `planMode=${isPlanMode}\n` +
        `collaborationMode=${collaborationMode}\n` +
        `finalPromptLength=${finalPrompt.length}`
      );

      const metrics = calculatePromptMetrics({
        toolDeclaration: compactToolsText,
        developerInstructions: "",
        history: "",
        toolResults: toolResultsContent,
        environment: envSection,
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
        toolPromptChars: compactToolsText.length,
        historyChars: 0,
        developerChars: 0,
        environmentChars: envSection.length,
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

    // -------------------------------------------------------------
    // CHẾ ĐỘ ĐẦY ĐỦ (FULL CONTEXT PROMPT - LƯỢT ĐẦU TIÊN)
    // -------------------------------------------------------------
    const sections: string[] = [];

    // =========================================================================
    // PHẦN 1: HỆ THỐNG GIAO TIẾP VỚI IDE & CÁC CHẾ ĐỘ THỰC THI
    // =========================================================================
    const systemParts: string[] = [UNIFIED_TOOL_PROTOCOL];

    if (isPlanMode) {
      systemParts.push(PLAN_MODE_PROMPT);
      systemParts.push(STRICT_ACTIONS_TOLERANT_ANSWERS_PLAN_PROMPT);
    } else if (isImplementingPlan) {
      systemParts.push(IMPLEMENT_PLAN_PROMPT);
      systemParts.push(STRICT_ACTIONS_TOLERANT_ANSWERS_PROMPT);
    } else {
      systemParts.push(STRICT_ACTIONS_TOLERANT_ANSWERS_PROMPT);
    }

    const systemProtocolSection = [
      "================================================================================",
      "# PHẦN 1: GIAO THỨC GIAO TIẾP VỚI IDE & NGUYÊN TẮC THỰC THI (PROTOCOL & POLICY)",
      "================================================================================",
      systemParts.join("\n\n"),
    ].join("\n");
    sections.push(systemProtocolSection);

    // =========================================================================
    // PHẦN 2: ACTION CONTRACT DYNAMIC THEO REQUEST THỰC TẾ
    // =========================================================================
    const dynamicToolsText = ToolDeclarationRenderer.renderDynamicToolDeclarations(normalized.activeCodingTools);
    const actionContractSection = [
      "================================================================================",
      "# PHẦN 2: BẢNG KHAI BÁO CÔNG CỤ HIỆN HÀNH (CODEX ACTION CONTRACT)",
      "================================================================================",
      dynamicToolsText,
    ].join("\n");
    sections.push(actionContractSection);

    // =========================================================================
    // PHẦN 3: BỐI CẢNH DỰ ÁN VÀ QUY TẮC PHÁT TRIỂN
    // =========================================================================
    const projectContextBlocks: string[] = [];
    let envContent = "";
    if (normalized.environmentContext) {
      envContent = `[NGỮ CẢNH DỰ ÁN & MÔI TRƯỜNG]:\n${normalized.environmentContext}`;
      projectContextBlocks.push(envContent);
    }

    let devInstructionsContent = "";
    if (normalized.developerInstructions && normalized.developerInstructions.length > 0) {
      const cleanedRules = normalized.developerInstructions
        .map((r: string) => PromptSanitizer.sanitizeCodexInstructions(r))
        .filter((r: string) => r.length > 0);
      if (cleanedRules.length > 0) {
        const devRules = cleanedRules.map((r: string) => `- ${r}`).join("\n");
        const devBlock = `[CHỈ THỊ CỦA DỰ ÁN / DEVELOPER RULES]:\n${devRules}`;
        devInstructionsContent = devInstructionsContent ? `${devInstructionsContent}\n\n${devBlock}` : devBlock;
        projectContextBlocks.push(devBlock);
      }
    }

    if (projectContextBlocks.length > 0) {
      const projectContextSection = [
        "================================================================================",
        "# PHẦN 3: BỐI CẢNH DỰ ÁN VÀ QUY TẮC PHÁT TRIỂN (PROJECT CONTEXT & RULES)",
        "================================================================================",
        projectContextBlocks.join("\n\n"),
      ].join("\n");
      sections.push(projectContextSection);
    }

    // =========================================================================
    // PHẦN 4: NHIỆM VỤ NGƯỜI DÙNG VÀ YÊU CẦU THỰC THI
    // =========================================================================
    const userTaskBlocks: string[] = [];

    // Lịch sử trao đổi đầy đủ
    let historyContent = "";
    if (normalized.priorHistory.length > 0) {
      const historyLines: string[] = [];
      for (const h of normalized.priorHistory) {
        if (h.role === "user") {
          historyLines.push(`Người dùng: ${h.content}`);
        } else if (h.role === "assistant") {
          historyLines.push(`Trợ lý: ${h.content}`);
        } else if (h.role === "tool") {
          historyLines.push(`<tool_result id="${h.callId || ""}">\n${PromptSanitizer.truncateToolResult(h.content)}\n</tool_result>`);
        }
      }
      if (historyLines.length > 0) {
        historyContent = `[LỊCH SỬ TRAO ĐỔI]:\n${historyLines.join("\n\n")}`;
        userTaskBlocks.push(historyContent);
      }
    }

    // Kết quả Tool gần nhất
    let toolResultsContent = "";
    if (normalized.trailingToolResults.length > 0) {
      const resultBlocks = normalized.trailingToolResults.map((res: NormalizedToolResult) => {
        const content = PromptSanitizer.truncateToolResult(res.output);
        const isFenced = content.startsWith("```");
        const safeBody = isFenced ? content : `\`\`\`\n${content}\n\`\`\``;
        return `<tool_result id="${res.callId}">\n${safeBody}\n</tool_result>`;
      });
      const hint = isPlanMode
        ? TOOL_RESULT_HINTS.planMode
        : (isImplementingPlan ? TOOL_RESULT_HINTS.implementPlan : TOOL_RESULT_HINTS.default);
      toolResultsContent = `[KẾT QUẢ THỰC THI CÔNG CỤ VỪA NHẬN ĐƯỢC TỪ IDE]:\n${resultBlocks.join("\n\n")}\n\n${hint}`;
      userTaskBlocks.push(toolResultsContent);
    }

    // Yêu cầu của người dùng mới nhất
    let userReqContent = "";
    if (normalized.latestUserInstruction) {
      userReqContent = `[YÊU CẦU CỦA NGƯỜI DÙNG]:\n${normalized.latestUserInstruction}`;
      userTaskBlocks.push(userReqContent);
    }

    // Thông báo hình ảnh đính kèm (nếu có)
    if (normalized.images && normalized.images.length > 0) {
      userTaskBlocks.push(WEB_IMAGE_ATTACHMENT_HINT);
    }

    // Lời nhắc định dạng chốt hạ ở cuối cùng (Anchor)
    const outputAnchorPrompt = isPlanMode
      ? SHORT_OUTPUT_FORMAT_PLAN_ANCHOR
      : SHORT_OUTPUT_FORMAT_ANCHOR;
    userTaskBlocks.push(outputAnchorPrompt);

    const userTaskSection = [
      "================================================================================",
      "# PHẦN 4: NHIỆM VỤ NGƯỜI DÙNG VÀ YÊU CẦU THỰC THI (USER TASK & EXECUTION)",
      "================================================================================",
      userTaskBlocks.join("\n\n"),
    ].join("\n");
    sections.push(userTaskSection);

    let finalPrompt = sections.join("\n\n").trim();

    // Budget Guard: Cắt tỉa nếu vượt quá ngưỡng an toàn
    if (finalPrompt.length > this.maxPromptChars) {
      const headLimit = 25_000;
      const tailLimit = this.maxPromptChars - headLimit - 200;
      const head = finalPrompt.slice(0, headLimit);
      const tail = finalPrompt.slice(-tailLimit);
      finalPrompt = `${head}\n\n... [Một số ngữ cảnh cũ được rút gọn để tối ưu độ dài] ...\n\n${tail}`;
    }

    console.log(
      `planMode=${isPlanMode}\n` +
      `collaborationMode=${collaborationMode}\n` +
      `finalPromptLength=${finalPrompt.length}`
    );

    const metrics = calculatePromptMetrics({
      toolDeclaration: `${systemProtocolSection}\n\n${actionContractSection}`,
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
      toolPromptChars: systemProtocolSection.length + actionContractSection.length,
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
