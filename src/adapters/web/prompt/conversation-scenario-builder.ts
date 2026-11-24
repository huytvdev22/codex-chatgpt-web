import {
  UNIFIED_TOOL_PROTOCOL,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  IMPLEMENT_PLAN_CONTINUATION_PROMPT,
  TOOL_REMINDER_PROMPT,
  TOOL_ERROR_FEEDBACK_PROMPT,
  APPLY_PATCH_ERROR_RECOVERY_HINT,
  PLAN_USER_INPUT_ANSWER_PROMPT,
  USER_INPUT_ANSWER_PROMPT,
  PLAN_SURVEY_CONTINUATION_PROMPT,
  SHORT_OUTPUT_FORMAT_ANCHOR,
  SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
  PURE_CONVERSATION_ANCHOR,
  STRUCTURED_JSON_OUTPUT_ANCHOR,
  WEB_IMAGE_ATTACHMENT_HINT,
} from "./templates";

/**
 * Các kịch bản hội thoại thực tế của người dùng với AI
 */
export type ConversationScenario =
  | "STRUCTURED_JSON_OUTPUT"      // Lượt yêu cầu Structured Output (json_schema) gọn nhẹ, không nạp bridge tool protocol
  | "FIRST_HANDSHAKE"             // Turn 1: Khởi tạo phiên mới toanh, giới thiệu script cầu nối
  | "PLAN_INITIATION"            // Turn bật /plan (chưa có kết quả tool)
  | "PLAN_SURVEY_CONTINUATION"   // Turn tiếp theo trong Plan Mode có kết quả tool khảo sát đọc file
  | "PLAN_USER_INPUT_ANSWER"     // Turn người dùng vừa trả lời wizard request_user_input trong Plan Mode
  | "USER_INPUT_ANSWER"          // Turn người dùng vừa trả lời wizard request_user_input trong Default Mode
  | "PLAN_KICKOFF"               // Turn 1 vừa bấm nút duyệt plan (chưa có kết quả tool)
  | "PLAN_CONTINUATION"          // Turn 2+ đang làm tiếp các bước của plan (có kết quả tool trước)
  | "TOOL_RESULT_CONTINUATION"   // Lượt nhận kết quả công cụ thông thường thành công
  | "TOOL_ERROR_FEEDBACK"        // Lượt nhận kết quả công cụ bị lỗi / thất bại
  | "PURE_CONVERSATION";         // Lượt đàm thoại, trao đổi, hỏi đáp liên tục (không có tool result)

export interface ScenarioBuilderInput {
  isStructuredJsonOutput?: boolean;
  isNewConversation: boolean;
  isPlanMode: boolean;
  isImplementingPlan: boolean;
  hasToolResults: boolean;
  hasToolErrors?: boolean;
  hasApplyPatchError?: boolean;
  hasUserInputAnswer?: boolean;
  userInputAnswersText?: string;
  includeEnvironment?: boolean;
  includeUserInstruction?: boolean;

  // Dữ liệu nội dung các khối
  structuredJsonOutputProtocol?: string;
  fullToolProtocol?: string;
  actionContractText: string;
  environmentText?: string;
  developerRulesText?: string;
  personalizationText?: string;
  workspaceMemoryHintText?: string;
  availableSkillsText?: string;
  selectedSkillsText?: string;
  systemPromptText?: string;
  priorHistoryText?: string;
  toolResultsText?: string;
  userInstructionText?: string;
  hasImages?: boolean;
}

export interface ScenarioBuildResult {
  scenario: ConversationScenario;
  finalPrompt: string;
  openingSection: string;
}

/**
 * Nhận diện chính xác kịch bản hội thoại hiện tại
 */
export function detectConversationScenario(input: {
  isStructuredJsonOutput?: boolean;
  isNewConversation: boolean;
  isPlanMode: boolean;
  isImplementingPlan: boolean;
  hasToolResults: boolean;
  hasToolErrors?: boolean;
  hasApplyPatchError?: boolean;
  hasUserInputAnswer?: boolean;
}): ConversationScenario {
  if (input.isStructuredJsonOutput) {
    return "STRUCTURED_JSON_OUTPUT";
  }

  if (input.isNewConversation) {
    return "FIRST_HANDSHAKE";
  }

  if (input.isImplementingPlan) {
    return input.hasToolResults ? "PLAN_CONTINUATION" : "PLAN_KICKOFF";
  }

  if (input.hasUserInputAnswer) {
    return input.isPlanMode ? "PLAN_USER_INPUT_ANSWER" : "USER_INPUT_ANSWER";
  }

  if (input.isPlanMode) {
    return input.hasToolResults ? "PLAN_SURVEY_CONTINUATION" : "PLAN_INITIATION";
  }

  if (input.hasToolResults) {
    return input.hasToolErrors ? "TOOL_ERROR_FEEDBACK" : "TOOL_RESULT_CONTINUATION";
  }

  return "PURE_CONVERSATION";
}

/**
 * Đạo diễn kịch bản hội thoại (Conversation Scenario Builder).
 * Ghép nối các mẫu lời nói tự nhiên từ templates.ts sao cho AI cảm thấy
 * nó đang trò chuyện thực sự với một lập trình viên trên khung chat.
 */
export class ConversationScenarioBuilder {
  buildTurnPrompt(input: ScenarioBuilderInput): ScenarioBuildResult {
    const scenario = detectConversationScenario({
      isStructuredJsonOutput: input.isStructuredJsonOutput,
      isNewConversation: input.isNewConversation,
      isPlanMode: input.isPlanMode,
      isImplementingPlan: input.isImplementingPlan,
      hasToolResults: input.hasToolResults,
      hasToolErrors: input.hasToolErrors,
      hasUserInputAnswer: input.hasUserInputAnswer,
    });

    const sections: string[] = [];
    let openingSection = "";

    switch (scenario) {
      case "STRUCTURED_JSON_OUTPUT": {
        // Lượt Structured Output (vd: sinh tiêu đề json_schema): chỉ gửi schema + ngữ cảnh yêu cầu, bỏ toàn bộ bridge tool protocol
        openingSection = input.structuredJsonOutputProtocol || "";
        if (openingSection) sections.push(openingSection);
        if (input.systemPromptText) sections.push(input.systemPromptText);
        if (input.priorHistoryText) sections.push(input.priorHistoryText);
        if (input.userInstructionText) sections.push(input.userInstructionText);
        if (input.hasImages) sections.push(WEB_IMAGE_ATTACHMENT_HINT);
        sections.push(STRUCTURED_JSON_OUTPUT_ANCHOR);
        break;
      }

      case "FIRST_HANDSHAKE": {
        // Turn 1: Thỏa thuận ban đầu, giới thiệu script cầu nối và toàn bộ kho công cụ
        openingSection = input.fullToolProtocol || UNIFIED_TOOL_PROTOCOL;
        sections.push(openingSection);
        sections.push(input.actionContractText);

        const projectContext: string[] = [];
        if (input.isPlanMode) {
          projectContext.push(PLAN_MODE_PROMPT);
        } else if (input.isImplementingPlan) {
          projectContext.push(IMPLEMENT_PLAN_PROMPT);
        }

        if (input.systemPromptText) projectContext.push(input.systemPromptText);
        if (input.environmentText) projectContext.push(input.environmentText);
        if (input.developerRulesText) projectContext.push(input.developerRulesText);
        if (input.personalizationText) projectContext.push(input.personalizationText);
        if (input.workspaceMemoryHintText) projectContext.push(input.workspaceMemoryHintText);
        if (input.availableSkillsText) projectContext.push(input.availableSkillsText);

        if (projectContext.length > 0) {
          sections.push(projectContext.join("\n\n"));
        }

        const taskBlocks: string[] = [];
        if (input.priorHistoryText) taskBlocks.push(input.priorHistoryText);
        if (input.toolResultsText) {
          if (input.hasApplyPatchError) {
            taskBlocks.push(APPLY_PATCH_ERROR_RECOVERY_HINT);
          }
          taskBlocks.push(input.toolResultsText);
        }
        if (input.selectedSkillsText) taskBlocks.push(input.selectedSkillsText);
        if (input.userInstructionText) taskBlocks.push(input.userInstructionText);
        if (input.hasImages) taskBlocks.push(WEB_IMAGE_ATTACHMENT_HINT);

        const anchor = input.isPlanMode
          ? SHORT_OUTPUT_FORMAT_PLAN_ANCHOR
          : SHORT_OUTPUT_FORMAT_ANCHOR;
        taskBlocks.push(
          `${anchor}\nLưu ý parser cầu nối: bạn không cần quyền truy cập trực tiếp IDE/shell; nếu cần đọc/sửa file hoặc chạy lệnh theo catalog, đừng từ chối vì "không có công cụ IDE" — chỉ cần xuất \`<tool_call>\` (vd \`{"name":"exec_command","arguments":{"cmd":"..."}}\`) hoặc \`<custom_tool_call name="apply_patch">\` để client máy mình thực thi và trả \`<tool_result>\`.`,
        );
        sections.push(taskBlocks.join("\n\n"));
        break;
      }

      case "PLAN_USER_INPUT_ANSWER": {
        const answers = input.userInputAnswersText ? `\n\n${input.userInputAnswersText}` : "";
        openingSection = `${PLAN_USER_INPUT_ANSWER_PROMPT}${answers}\n\nBạn dựa trên các lựa chọn này của mình cùng kết quả khảo sát để tổng hợp và xuất bản bản kế hoạch hoàn chỉnh bọc trong cặp thẻ <proposed_plan>...</proposed_plan> bằng tiếng Việt cho mình duyệt nhé!`.trim();
        sections.push(openingSection);
        this.appendContinuationSections(sections, input, {
          includeToolResults: true,
          anchor: SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
        });
        break;
      }

      case "USER_INPUT_ANSWER": {
        const answers = input.userInputAnswersText ? `\n\n${input.userInputAnswersText}` : "";
        openingSection = `${USER_INPUT_ANSWER_PROMPT}${answers}`.trim();
        sections.push(openingSection);
        this.appendContinuationSections(sections, input, {
          includeToolResults: true,
          anchor: SHORT_OUTPUT_FORMAT_ANCHOR,
        });
        break;
      }

      case "PLAN_SURVEY_CONTINUATION": {
        openingSection = PLAN_SURVEY_CONTINUATION_PROMPT;
        sections.push(openingSection);
        this.appendContinuationSections(sections, input, {
          includeToolResults: true,
          anchor: SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
        });
        break;
      }

      case "PLAN_INITIATION": {
        openingSection = PLAN_MODE_PROMPT;
        sections.push(openingSection);
        this.appendContinuationSections(sections, input, {
          includeToolResults: false,
          anchor: SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
        });
        break;
      }

      case "PLAN_KICKOFF": {
        openingSection = IMPLEMENT_PLAN_PROMPT;
        sections.push(openingSection);
        this.appendContinuationSections(sections, input, {
          includeToolResults: false,
          anchor: SHORT_OUTPUT_FORMAT_ANCHOR,
        });
        break;
      }

      case "PLAN_CONTINUATION": {
        openingSection = input.hasApplyPatchError
          ? `${TOOL_ERROR_FEEDBACK_PROMPT}\n\n${APPLY_PATCH_ERROR_RECOVERY_HINT}`
          : input.hasToolErrors
            ? TOOL_ERROR_FEEDBACK_PROMPT
            : IMPLEMENT_PLAN_CONTINUATION_PROMPT;
        sections.push(openingSection);
        this.appendContinuationSections(sections, input, {
          includeToolResults: true,
          anchor: SHORT_OUTPUT_FORMAT_ANCHOR,
        });
        break;
      }

      case "TOOL_ERROR_FEEDBACK": {
        openingSection = input.hasApplyPatchError
          ? `${TOOL_ERROR_FEEDBACK_PROMPT}\n\n${APPLY_PATCH_ERROR_RECOVERY_HINT}`
          : TOOL_ERROR_FEEDBACK_PROMPT;
        sections.push(openingSection);
        this.appendContinuationSections(sections, input, {
          includeToolResults: true,
          anchor: SHORT_OUTPUT_FORMAT_ANCHOR,
        });
        break;
      }

      case "TOOL_RESULT_CONTINUATION": {
        openingSection = TOOL_REMINDER_PROMPT;
        sections.push(openingSection);
        this.appendContinuationSections(sections, input, {
          includeToolResults: true,
          anchor: SHORT_OUTPUT_FORMAT_ANCHOR,
        });
        break;
      }

      case "PURE_CONVERSATION":
      default: {
        openingSection = "";
        this.appendContinuationSections(sections, input, {
          includeToolResults: false,
          includeWorkspaceMemoryHint: true,
          anchor: PURE_CONVERSATION_ANCHOR,
        });
        break;
      }
    }

    const finalPrompt = sections.filter(Boolean).join("\n\n").trim();

    return {
      scenario,
      finalPrompt,
      openingSection,
    };
  }

  private appendContinuationSections(
    sections: string[],
    input: ScenarioBuilderInput,
    options: { includeToolResults: boolean; includeWorkspaceMemoryHint?: boolean; anchor: string },
  ): void {
    if (input.includeEnvironment !== false && input.environmentText) {
      sections.push(input.environmentText);
    }
    if (input.personalizationText) {
      sections.push(input.personalizationText);
    }
    if (options.includeWorkspaceMemoryHint && input.workspaceMemoryHintText) {
      sections.push(input.workspaceMemoryHintText);
    }
    if (input.availableSkillsText) {
      sections.push(input.availableSkillsText);
    }
    if (input.actionContractText) {
      sections.push(input.actionContractText);
    }
    if (options.includeToolResults && input.toolResultsText) {
      sections.push(input.toolResultsText);
    }
    if (input.selectedSkillsText) {
      sections.push(input.selectedSkillsText);
    }
    if (input.includeUserInstruction !== false && input.userInstructionText) {
      sections.push(input.userInstructionText);
    }
    if (input.hasImages) {
      sections.push(WEB_IMAGE_ATTACHMENT_HINT);
    }
    if (options.anchor) {
      sections.push(options.anchor);
    }
  }
}

export const conversationScenarioBuilder = new ConversationScenarioBuilder();
