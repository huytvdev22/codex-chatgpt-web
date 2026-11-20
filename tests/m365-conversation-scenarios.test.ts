import { describe, expect, test } from "bun:test";
import {
  conversationScenarioBuilder,
  detectConversationScenario,
  type ConversationScenario,
} from "../src/adapters/web/prompt/conversation-scenario-builder";
import {
  promptCompiler,
  isApplyPatchVerificationError,
  isToolResultError,
  sanitizeCodexInstructions,
} from "../src/adapters/web/prompt/compiler";
import {
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  IMPLEMENT_PLAN_CONTINUATION_PROMPT,
  TOOL_REMINDER_PROMPT,
  TOOL_ERROR_FEEDBACK_PROMPT,
  APPLY_PATCH_ERROR_RECOVERY_HINT,
  PURE_CONVERSATION_ANCHOR,
} from "../src/adapters/web/prompt/templates";

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
    expect(res.finalPrompt).toContain("Chào Copilot");
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

    // Phải dùng template tiếp nối bước sau (siêu gọn, không lặp lại danh sách tool)
    expect(res.finalPrompt).toContain(IMPLEMENT_PLAN_CONTINUATION_PROMPT);
    expect(res.finalPrompt).toContain("kế tiếp của kế hoạch");
    // Không được lặp lại câu duyệt plan như người mất trí nhớ
    expect(res.finalPrompt).not.toContain("Bản kế hoạch bạn vừa lên rất chi tiết và hợp lý, mình duyệt rồi nhé!");
    expect(res.finalPrompt).not.toContain("[MCP TOOL CATALOG]");
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

    expect(res.finalPrompt).toContain(TOOL_REMINDER_PROMPT);
    expect(res.finalPrompt).toContain("<tool_result id=\"c_read\">");
    expect(res.finalPrompt).not.toContain("[MCP TOOL CATALOG]");
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

    expect(res.finalPrompt).toContain(TOOL_ERROR_FEEDBACK_PROMPT);
    expect(res.finalPrompt).toContain("Process exited with code 1");
    expect(res.finalPrompt).not.toContain("[MCP TOOL CATALOG]");
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

    // Tuyệt đối không có lời nhắc tool hoặc lặp lại tool catalog
    expect(res.finalPrompt).not.toContain("Mình vừa chạy các công cụ");
    expect(res.finalPrompt).not.toContain(TOOL_REMINDER_PROMPT);
    expect(res.finalPrompt).not.toContain("[MCP TOOL CATALOG]");
    // Có anchor đàm thoại tự nhiên
    expect(res.finalPrompt).toContain(PURE_CONVERSATION_ANCHOR);
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

  test("12. Nhận diện chính xác apply_patch verification failed và exit code khác 1 để bơm APPLY_PATCH_ERROR_RECOVERY_HINT", () => {
    const patchFailureOutput =
      "apply_patch verification failed: Failed to find expected lines in D:\\Tiet kiem\\TestDesign.md:\n### TC-04: Validate";
    expect(
      isApplyPatchVerificationError({ toolName: "apply_patch", output: patchFailureOutput }),
    ).toBe(true);
    expect(
      isToolResultError({ toolName: "apply_patch", output: patchFailureOutput }),
    ).toBe(true);
    expect(
      isToolResultError({ toolName: "exec_command", output: "Process exited with code 2\nSyntax error" }),
    ).toBe(true);
    // File stdout thành công chứa chữ 'Failed to find expected lines' không bị nhận nhầm là apply_patch error
    expect(
      isApplyPatchVerificationError({
        toolName: "exec_command",
        output: "Chunk ID: c1\nProcess exited with code 0\nOutput:\nconst msg = 'Failed to find expected lines';",
      }),
    ).toBe(false);

    const compiled = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        trailingToolResults: [
          {
            callId: "call_h4kmxe5f",
            toolName: "apply_patch",
            output: patchFailureOutput,
          },
        ],
        latestUserInstruction: "cập nhật testcase",
      },
      parsed: { ...baseParsed },
      isNewConversation: false,
    });

    expect(compiled.scenario).toBe("TOOL_ERROR_FEEDBACK");
    expect(compiled.finalPrompt).toContain(TOOL_ERROR_FEEDBACK_PROMPT);
    expect(compiled.finalPrompt).toContain(APPLY_PATCH_ERROR_RECOVERY_HINT);
    expect(compiled.finalPrompt).not.toContain(TOOL_REMINDER_PROMPT);

    const planCompiled = promptCompiler.compile({
      normalized: {
        ...baseNormalized,
        trailingToolResults: [
          {
            callId: "call_plan_patch_fail",
            toolName: "apply_patch",
            output: patchFailureOutput,
          },
        ],
        latestUserInstruction: "Yes, implement this plan",
      },
      parsed: {
        ...baseParsed,
        context: {
          ...baseParsed.context,
          messages: [{ role: "user", content: "Yes, implement this plan" }],
        },
      },
      isNewConversation: false,
      isImplementingPlan: true,
    });

    expect(planCompiled.scenario).toBe("PLAN_CONTINUATION");
    expect(planCompiled.finalPrompt).toContain(TOOL_ERROR_FEEDBACK_PROMPT);
    expect(planCompiled.finalPrompt).toContain(APPLY_PATCH_ERROR_RECOVERY_HINT);
  });
});
