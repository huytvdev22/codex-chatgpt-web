import { describe, expect, test } from "bun:test";
import {
  conversationScenarioBuilder,
  detectConversationScenario,
  type ConversationScenario,
} from "../src/adapters/m365-copilot/prompts/conversation-scenario-builder";
import { promptCompiler } from "../src/adapters/m365-copilot/prompts/compiler";
import {
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  IMPLEMENT_PLAN_CONTINUATION_PROMPT,
  TOOL_REMINDER_PROMPT,
  TOOL_ERROR_FEEDBACK_PROMPT,
  PURE_CONVERSATION_ANCHOR,
} from "../src/adapters/m365-copilot/prompts/templates";
import { sanitizeCodexInstructions } from "../src/adapters/m365-copilot/prompts/compiler";

describe("M365 Conversation Scenario Builder & Human-Companion Tone Tests", () => {
  const baseNormalized: any = {
    threadId: "th_test_scenario",
    turnId: "turn_1",
    collaborationMode: "default",
    activeCodingTools: [],
    priorHistory: [],
    trailingToolResults: [],
    latestUserInstruction: "Hello Copilot",
    environmentContext: "- Cwd: /workspace/project\n- Shell: zsh",
  };

  const baseParsed: any = {
    modelId: "m365-copilot/chat",
    stream: true,
    options: {},
    context: { messages: [] },
  };

  test("1. Kịch bản FIRST_HANDSHAKE: Lượt mở đầu chào hỏi & thỏa thuận quy ước ban đầu", () => {
    const scenario = detectConversationScenario({
      isNewConversation: true,
      isPlanMode: false,
      isImplementingPlan: false,
      hasToolResults: false,
    });
    expect(scenario).toBe("FIRST_HANDSHAKE");

    const res = promptCompiler.compile({
      normalized: { ...baseNormalized },
      parsed: { ...baseParsed },
      isNewConversation: true,
    });
    expect(res.finalPrompt).toContain("Chào Copilot, mình đang làm việc trên một dự án phần mềm ở máy cá nhân");
    expect(res.finalPrompt).toContain("<webResponse>");
  });

  test("2. Kịch bản PLAN_INITIATION: Khởi tạo Plan Mode không bị chèn câu tool result vô lý", () => {
    const scenario = detectConversationScenario({
      isNewConversation: false,
      isPlanMode: true,
      isImplementingPlan: false,
      hasToolResults: false,
    });
    expect(scenario).toBe("PLAN_INITIATION");

    const res = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        collaborationMode: "plan",
        trailingToolResults: [], // Chưa có tool nào chạy
        latestUserInstruction: "Lên plan làm Todo app",
      },
      parsed: { ...baseParsed },
      isNewConversation: false,
    });

    // Phải chứa chỉ dẫn Plan Mode thân thiện
    expect(res.finalPrompt).toContain("Bạn ơi, với yêu cầu này mình muốn cùng bạn khảo sát kỹ và lên kế hoạch trước");
    expect(res.finalPrompt).toContain("<proposed_plan>");
    // Tuyệt đối KHÔNG được chèn lời nhắc "Mình vừa chạy các công cụ..."
    expect(res.finalPrompt).not.toContain("Mình vừa chạy các công cụ bạn yêu cầu trên máy xong");
    expect(res.finalPrompt).not.toContain(TOOL_REMINDER_PROMPT);
  });

  test("3. Kịch bản PLAN_KICKOFF: Lượt vừa duyệt plan (Turn 1 của implement)", () => {
    const scenario = detectConversationScenario({
      isNewConversation: false,
      isPlanMode: false,
      isImplementingPlan: true,
      hasToolResults: false,
    });
    expect(scenario).toBe("PLAN_KICKOFF");

    const res = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        trailingToolResults: [],
        latestUserInstruction: "Triển khai bước 1",
      },
      parsed: { ...baseParsed },
      isNewConversation: false,
      isImplementingPlan: true,
    });

    expect(res.finalPrompt).toContain("Bản kế hoạch bạn vừa lên rất chi tiết và hợp lý, mình duyệt rồi nhé!");
    expect(res.finalPrompt).toContain("bước đầu tiên");
  });

  test("4. Kịch bản PLAN_CONTINUATION: Lượt tiếp theo khi đang làm dở plan (không lặp lại câu duyệt plan)", () => {
    const scenario = detectConversationScenario({
      isNewConversation: false,
      isPlanMode: false,
      isImplementingPlan: true,
      hasToolResults: true,
    });
    expect(scenario).toBe("PLAN_CONTINUATION");

    const res = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        trailingToolResults: [
          { callId: "c_patch_1", toolName: "apply_patch", output: "Thành công: Đã tạo index.html" },
        ],
        latestUserInstruction: "tiếp tục bước 2",
      },
      parsed: { ...baseParsed },
      isNewConversation: false,
      isImplementingPlan: true,
    });

    // Phải dùng template tiếp nối bước sau
    expect(res.finalPrompt).toContain("Mình gửi bạn kết quả bước vừa rồi trong thẻ <tool_result> bên dưới nhé");
    expect(res.finalPrompt).toContain("triển khai tiếp bước kế tiếp trong kế hoạch");
    // Không được lặp lại câu duyệt plan như người mất trí nhớ
    expect(res.finalPrompt).not.toContain("Bản kế hoạch bạn vừa lên rất chi tiết và hợp lý, mình duyệt rồi nhé!");
  });

  test("5. Kịch bản TOOL_RESULT_CONTINUATION: Lượt nhận kết quả công cụ bình thường thành công", () => {
    const scenario = detectConversationScenario({
      isNewConversation: false,
      isPlanMode: false,
      isImplementingPlan: false,
      hasToolResults: true,
      hasToolErrors: false,
    });
    expect(scenario).toBe("TOOL_RESULT_CONTINUATION");

    const res = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        trailingToolResults: [
          { callId: "c_read", toolName: "read_file", output: "const a = 1;" },
        ],
        latestUserInstruction: "kiểm tra tiếp",
      },
      parsed: { ...baseParsed },
      isNewConversation: false,
    });

    expect(res.finalPrompt).toContain("Mình vừa chạy các lệnh bạn yêu cầu xong, gửi bạn kết quả trong thẻ <tool_result> bên dưới nhé");
  });

  test("6. Kịch bản TOOL_ERROR_FEEDBACK: Báo lỗi lệnh thân thiện như đồng nghiệp khi lệnh thất bại", () => {
    const scenario = detectConversationScenario({
      isNewConversation: false,
      isPlanMode: false,
      isImplementingPlan: false,
      hasToolResults: true,
      hasToolErrors: true,
    });
    expect(scenario).toBe("TOOL_ERROR_FEEDBACK");

    const res = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        trailingToolResults: [
          { callId: "c_cmd", toolName: "exec_command", output: "Command failed: Process exited with code 1\nSyntaxError" },
        ],
        latestUserInstruction: "sửa lại lỗi giúp mình",
      },
      parsed: { ...baseParsed },
      isNewConversation: false,
    });

    expect(res.finalPrompt).toContain("Bạn ơi, lệnh hoặc công cụ vừa rồi trên máy mình chạy bị báo lỗi");
    expect(res.finalPrompt).toContain("sửa lại giúp mình nha!");
  });

  test("7. Kịch bản PURE_CONVERSATION: Đàm thoại thông thường tiếp theo (không có tool result)", () => {
    const scenario = detectConversationScenario({
      isNewConversation: false,
      isPlanMode: false,
      isImplementingPlan: false,
      hasToolResults: false,
    });
    expect(scenario).toBe("PURE_CONVERSATION");

    const res = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        trailingToolResults: [], // Không có tool nào
        latestUserInstruction: "Giải thích giúp mình hàm calculateTotals hoạt động ra sao?",
      },
      parsed: { ...baseParsed },
      isNewConversation: false,
    });

    // Tuyệt đối không có lời nhắc tool
    expect(res.finalPrompt).not.toContain("Mình vừa chạy các công cụ");
    expect(res.finalPrompt).not.toContain(TOOL_REMINDER_PROMPT);
    // Có anchor đàm thoại tự nhiên
    expect(res.finalPrompt).toContain("Nếu chỉ trả lời/thảo luận: Bạn cứ viết nội dung Markdown tự nhiên trong cặp thẻ <webResponse>");
    expect(res.finalPrompt).toContain("Giải thích giúp mình hàm calculateTotals hoạt động ra sao?");
  });

  test("8. Lọc sạch hoàn toàn chỉ dẫn tiếng Anh của OpenAI về request_user_input", () => {
    const dirtyInstruction =
      "Never use the request_user_input tool unless necessary. Use the request_user_input tool only when you must ask the user a question. Always format questions nicely.";
    const cleaned = sanitizeCodexInstructions(dirtyInstruction);
    expect(cleaned).toBe("");

    const normalInstruction = "Luôn viết mã nguồn bằng TypeScript với strict typing.";
    expect(sanitizeCodexInstructions(normalInstruction)).toBe(normalInstruction);
  });

  test("9. Kịch bản PLAN_USER_INPUT_ANSWER: Nhận các lựa chọn của wizard và đưa vào prompt xuất bản plan", () => {
    const rawAnswers = JSON.stringify({
      features: "Todo đầy đủ (Recommended)",
      design: "Modern Minimal (Recommended)",
      storage: "LocalStorage (Recommended)",
    });

    const res = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        collaborationMode: "plan",
        trailingToolResults: [
          {
            callId: "call_wizard_1",
            toolName: "request_user_input",
            output: rawAnswers,
          },
        ],
        latestUserInstruction: "lên plan làm 1 trang web todo bằng html, js, css nhé .",
      },
      parsed: { ...baseParsed },
      isNewConversation: false,
    });

    expect(res.finalPrompt).toContain("[MÌNH ĐÃ CHỌN XONG CÁC PHƯƠNG ÁN - BẮT ĐẦU XUẤT BẢN KẾ HOẠCH]");
    expect(res.finalPrompt).toContain("- **features**: Todo đầy đủ (Recommended)");
    expect(res.finalPrompt).toContain("- **design**: Modern Minimal (Recommended)");
    expect(res.finalPrompt).toContain("- **storage**: LocalStorage (Recommended)");
    expect(res.finalPrompt).toContain("<proposed_plan>");
    expect(res.finalPrompt).toContain("lên plan làm 1 trang web todo bằng html, js, css nhé .");
  });

  test("10. Kịch bản PLAN_SURVEY_CONTINUATION: Bảo toàn kết quả đọc file khảo sát trong Plan Mode", () => {
    const res = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        collaborationMode: "plan",
        trailingToolResults: [
          {
            callId: "call_read_1",
            toolName: "read_file",
            output: "package.json content: { name: 'todo-app' }",
          },
        ],
        latestUserInstruction: "lên plan làm 1 trang web todo",
      },
      parsed: { ...baseParsed },
      isNewConversation: false,
    });

    expect(res.finalPrompt).toContain("[KẾT QUẢ KHẢO SÁT MÃ NGUỒN - PLAN MODE]");
    expect(res.finalPrompt).toContain("package.json content: { name: 'todo-app' }");
    expect(res.finalPrompt).toContain("<proposed_plan>");
  });

  test("11. Kịch bản USER_INPUT_ANSWER: Trả lời câu hỏi wizard trong Default Mode", () => {
    const rawAnswers = JSON.stringify({
      confirm: "Đồng ý triển khai",
    });

    const res = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        collaborationMode: "default",
        trailingToolResults: [
          {
            callId: "call_user_input_2",
            toolName: "request_user_input",
            output: rawAnswers,
          },
        ],
        latestUserInstruction: "tiếp tục",
      },
      parsed: { ...baseParsed },
      isNewConversation: false,
    });

    expect(res.finalPrompt).toContain("[CÂU TRẢ LỜI CỦA MÌNH CHO CÂU HỎI CỦA BẠN]");
    expect(res.finalPrompt).toContain("- **confirm**: Đồng ý triển khai");
  });
});
