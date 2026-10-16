import {
  UNIFIED_TOOL_PROTOCOL,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  IMPLEMENT_PLAN_CONTINUATION_PROMPT,
  TOOL_REMINDER_PROMPT,
  TOOL_ERROR_FEEDBACK_PROMPT,
  PLAN_USER_INPUT_ANSWER_PROMPT,
  USER_INPUT_ANSWER_PROMPT,
  PLAN_SURVEY_CONTINUATION_PROMPT,
  SHORT_OUTPUT_FORMAT_ANCHOR,
  SHORT_OUTPUT_FORMAT_PLAN_ANCHOR,
  PURE_CONVERSATION_ANCHOR,
  M365_IMAGE_ATTACHMENT_HINT,
} from "./templates";

/**
 * Các kịch bản hội thoại thực tế của người dùng với AI
 */
export type ConversationScenario =
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
  isNewConversation: boolean;
  isPlanMode: boolean;
  isImplementingPlan: boolean;
  hasToolResults: boolean;
  hasToolErrors?: boolean;
  hasUserInputAnswer?: boolean;
  userInputAnswersText?: string;

  // Dữ liệu nội dung các khối
  fullToolProtocol?: string;
  actionContractText: string;
  environmentText?: string;
  developerRulesText?: string;
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
  isNewConversation: boolean;
  isPlanMode: boolean;
  isImplementingPlan: boolean;
  hasToolResults: boolean;
  hasToolErrors?: boolean;
  hasUserInputAnswer?: boolean;
}): ConversationScenario {
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

        if (projectContext.length > 0) {
          sections.push(projectContext.join("\n\n"));
        }

        const taskBlocks: string[] = [];
        if (input.priorHistoryText) taskBlocks.push(input.priorHistoryText);
        if (input.toolResultsText) taskBlocks.push(input.toolResultsText);
        if (input.userInstructionText) taskBlocks.push(input.userInstructionText);
        if (input.hasImages) taskBlocks.push(M365_IMAGE_ATTACHMENT_HINT);

        taskBlocks.push(
          input.isPlanMode ? SHORT_OUTPUT_FORMAT_PLAN_ANCHOR : SHORT_OUTPUT_FORMAT_ANCHOR
        );
        sections.push(taskBlocks.join("\n\n"));
        break;
      }

      case "PLAN_USER_INPUT_ANSWER": {
        // Lượt người dùng vừa chọn phương án từ wizard request_user_input trong Plan Mode
        const answers = input.userInputAnswersText ? `\n\n${input.userInputAnswersText}` : "";
        openingSection = `${PLAN_USER_INPUT_ANSWER_PROMPT}${answers}\n\nBạn dựa trên các lựa chọn này của mình cùng kết quả khảo sát để tổng hợp và xuất bản bản kế hoạch hoàn chỉnh bọc trong cặp thẻ <proposed_plan>...</proposed_plan> bằng tiếng Việt cho mình duyệt nhé!`.trim();
        sections.push(openingSection);

        if (input.environmentText) sections.push(input.environmentText);
        sections.push(input.actionContractText);

        if (input.toolResultsText) sections.push(input.toolResultsText);
        if (input.userInstructionText) sections.push(input.userInstructionText);
        if (input.hasImages) sections.push(M365_IMAGE_ATTACHMENT_HINT);

        sections.push(SHORT_OUTPUT_FORMAT_PLAN_ANCHOR);
        break;
      }

      case "USER_INPUT_ANSWER": {
        // Lượt người dùng vừa trả lời wizard trong Default Mode
        const answers = input.userInputAnswersText ? `\n\n${input.userInputAnswersText}` : "";
        openingSection = `${USER_INPUT_ANSWER_PROMPT}${answers}`.trim();
        sections.push(openingSection);

        if (input.environmentText) sections.push(input.environmentText);
        sections.push(input.actionContractText);

        if (input.toolResultsText) sections.push(input.toolResultsText);
        if (input.userInstructionText) sections.push(input.userInstructionText);
        if (input.hasImages) sections.push(M365_IMAGE_ATTACHMENT_HINT);

        sections.push(SHORT_OUTPUT_FORMAT_ANCHOR);
        break;
      }

      case "PLAN_SURVEY_CONTINUATION": {
        // Turn tiếp theo trong Plan Mode (đã có kết quả đọc file khảo sát từ bước trước)
        openingSection = PLAN_SURVEY_CONTINUATION_PROMPT;
        sections.push(openingSection);

        if (input.environmentText) sections.push(input.environmentText);
        sections.push(input.actionContractText);

        if (input.toolResultsText) sections.push(input.toolResultsText);
        if (input.hasImages) sections.push(M365_IMAGE_ATTACHMENT_HINT);

        sections.push(SHORT_OUTPUT_FORMAT_PLAN_ANCHOR);
        break;
      }

      case "PLAN_INITIATION": {
        // Turn bắt đầu Plan Mode (chưa có tool result)
        // Tuyệt đối KHÔNG chèn TOOL_REMINDER_PROMPT "Mình vừa chạy các công cụ..."
        openingSection = PLAN_MODE_PROMPT;
        sections.push(openingSection);

        if (input.environmentText) sections.push(input.environmentText);
        sections.push(input.actionContractText);

        if (input.userInstructionText) sections.push(input.userInstructionText);
        if (input.hasImages) sections.push(M365_IMAGE_ATTACHMENT_HINT);

        sections.push(SHORT_OUTPUT_FORMAT_PLAN_ANCHOR);
        break;
      }

      case "PLAN_KICKOFF": {
        // Lượt đầu tiên vừa bấm nút Duyệt Plan (chưa có tool result)
        openingSection = IMPLEMENT_PLAN_PROMPT;
        sections.push(openingSection);

        if (input.environmentText) sections.push(input.environmentText);
        sections.push(input.actionContractText);

        if (input.userInstructionText) sections.push(input.userInstructionText);
        if (input.hasImages) sections.push(M365_IMAGE_ATTACHMENT_HINT);

        sections.push(SHORT_OUTPUT_FORMAT_ANCHOR);
        break;
      }

      case "PLAN_CONTINUATION": {
        // Lượt tiếp theo của Plan (đã có tool result của bước trước)
        // Không lặp lại câu duyệt plan và không lặp lại yêu cầu cũ của người dùng
        openingSection = IMPLEMENT_PLAN_CONTINUATION_PROMPT;
        sections.push(openingSection);

        if (input.environmentText) sections.push(input.environmentText);
        sections.push(input.actionContractText);

        if (input.toolResultsText) sections.push(input.toolResultsText);
        if (input.hasImages) sections.push(M365_IMAGE_ATTACHMENT_HINT);

        sections.push(SHORT_OUTPUT_FORMAT_ANCHOR);
        break;
      }

      case "TOOL_ERROR_FEEDBACK": {
        // Lượt lệnh trên máy bị lỗi: Báo lỗi thân thiện như đồng nghiệp
        openingSection = TOOL_ERROR_FEEDBACK_PROMPT;
        sections.push(openingSection);

        if (input.environmentText) sections.push(input.environmentText);
        sections.push(input.actionContractText);

        if (input.toolResultsText) sections.push(input.toolResultsText);
        if (input.hasImages) sections.push(M365_IMAGE_ATTACHMENT_HINT);

        sections.push(SHORT_OUTPUT_FORMAT_ANCHOR);
        break;
      }

      case "TOOL_RESULT_CONTINUATION": {
        // Lượt nhận kết quả công cụ thông thường ngoài Plan Mode
        // Tập trung báo kết quả công cụ, không duplicate lại yêu cầu cũ của người dùng
        openingSection = TOOL_REMINDER_PROMPT;
        sections.push(openingSection);

        if (input.environmentText) sections.push(input.environmentText);
        sections.push(input.actionContractText);

        if (input.toolResultsText) sections.push(input.toolResultsText);
        if (input.hasImages) sections.push(M365_IMAGE_ATTACHMENT_HINT);

        sections.push(SHORT_OUTPUT_FORMAT_ANCHOR);
        break;
      }

      case "PURE_CONVERSATION":
      default: {
        // Lượt đàm thoại, trao đổi, hỏi đáp bình thường hàng ngày (KHÔNG CÓ tool_result)
        // Tuyệt đối không chèn "Mình vừa chạy các công cụ..."
        openingSection = ""; // Không có lời nhắc công cụ mở đầu
        if (input.environmentText) sections.push(input.environmentText);
        sections.push(input.actionContractText);

        if (input.userInstructionText) sections.push(input.userInstructionText);
        if (input.hasImages) sections.push(M365_IMAGE_ATTACHMENT_HINT);

        sections.push(PURE_CONVERSATION_ANCHOR);
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
}

export const conversationScenarioBuilder = new ConversationScenarioBuilder();
