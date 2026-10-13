import { describe, expect, test } from "bun:test";
import {
  BasePromptCompiler,
  BasePromptAssembler,
  ToolDescriptionCurator,
  ToolDeclarationRenderer,
  PromptSanitizer,
  FormatRetryBuilder,
  PlanModeDetector,
  UNIFIED_TOOL_PROTOCOL,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
} from "../src/adapters/base-web/prompts";
import type { NormalizedCodexRequest, NormalizedTool } from "../src/adapters/base-web/normalization";
import type { CodexParsedRequest } from "../src/types";

describe("BaseWeb - Prompts Subsystem Tests", () => {
  const sampleTools: NormalizedTool[] = [
    {
      kind: "function",
      identity: { name: "exec_command", qualifiedName: "exec_command" },
      description: "Chạy câu lệnh CLI không tương tác",
      rawParameters: {
        type: "object",
        properties: { cmd: { type: "string", description: "Lệnh shell" } },
        required: ["cmd"],
      },
    },
    {
      kind: "custom",
      identity: { name: "apply_patch", qualifiedName: "apply_patch" },
      description: "Tạo hoặc sửa file bằng unified diff patch",
      format: "patch",
    },
  ];

  const sampleNormalized: NormalizedCodexRequest = {
    model: "test-model",
    stream: true,
    threadId: "test-thread",
    turnId: "test-turn",
    developerInstructions: ["Tuân thủ nguyên tắc SOLID."],
    environmentContext: "- Cwd: /workspace\n- Shell: bash",
    priorHistory: [
      { role: "user", content: "Chào bạn, hãy tạo file test." },
      { role: "assistant", content: "Tôi sẽ tạo file test cho bạn." },
    ],
    latestUserInstruction: "Hãy tiếp tục bước 2.",
    trailingToolResults: [
      { callId: "call_1", output: "Process exited with code 0" },
    ],
    tools: sampleTools,
    activeCodingTools: sampleTools,
    executionPolicy: { parallelToolCalls: false },
    collaborationMode: "default",
    rawSnapshot: {} as any,
  };

  test("ToolDescriptionCurator: cleanToolDescription loại bỏ tokens rác và Windows rules", () => {
    const raw = "Runs command in shell. Windows safety rules: Do not run rm -rf. ¨C12C";
    const cleaned = ToolDescriptionCurator.cleanToolDescription("exec_command", raw);
    expect(cleaned).not.toContain("Windows safety rules:");
    expect(cleaned).not.toContain("¨C12C");
    expect(cleaned).toContain("Runs command in shell.");
  });

  test("ToolDeclarationRenderer: renderDynamicToolDeclarations kết xuất đủ function và freeform action", () => {
    const rendered = ToolDeclarationRenderer.renderDynamicToolDeclarations(sampleTools);
    expect(rendered).toContain("CODEX ACTION CONTRACT FOR THIS IDE TURN");
    expect(rendered).toContain("exec_command (function)");
    expect(rendered).toContain("apply_patch (freeform)");
    expect(rendered).toContain("FUNCTION ACTION EXAMPLE");
    expect(rendered).toContain("FREEFORM ACTION EXAMPLE");
  });

  test("ToolDeclarationRenderer: renderCompactDynamicToolDeclarations kết xuất danh sách súc tích", () => {
    const compact = ToolDeclarationRenderer.renderCompactDynamicToolDeclarations(sampleTools);
    expect(compact).toContain("CODEX ACTION CONTRACT FOR THIS IDE TURN (COMPACT)");
    expect(compact).toContain("- exec_command [function]: cmd*");
    expect(compact).toContain("- apply_patch [freeform]");
  });

  test("PromptSanitizer: truncateToolResult cắt tỉa kết quả khi vượt quá ngưỡng", () => {
    const longText = "a".repeat(10_000);
    const truncated = PromptSanitizer.truncateToolResult(longText, 1_000);
    expect(truncated.length).toBeLessThan(1_500);
    expect(truncated).toContain("Đã lược bớt");
  });

  test("PromptSanitizer: sanitizeCodexInstructions làm sạch boilerplate OpenAI", () => {
    const rawDev = "You are Codex, an AI assistant.\n<sandbox_mode>strict</sandbox_mode>\n\nTuân thủ SOLID.";
    const cleaned = PromptSanitizer.sanitizeCodexInstructions(rawDev);
    expect(cleaned).not.toContain("You are Codex");
    expect(cleaned).not.toContain("<sandbox_mode>");
    expect(cleaned).toContain("Tuân thủ SOLID.");
  });

  test("FormatRetryBuilder: buildFormatRetryPrompt tạo prompt follow-up hợp lệ", () => {
    const prompt = FormatRetryBuilder.buildFormatRetryPrompt({
      code: "ERR_NO_FENCE",
      message: "Thiếu khối 4-backtick",
    });
    expect(prompt).toContain("[M365 RESPONSE FORMAT ERROR - BẮT BUỘC PHÁT LẠI PHẢN HỒI TRƯỚC]");
    expect(prompt).toContain("ERR_NO_FENCE");
    expect(prompt).toContain("Thiếu khối 4-backtick");
  });

  test("PlanModeDetector: nhận diện chính xác Plan Mode và Implementing Plan", () => {
    const mockImplementing: CodexParsedRequest = {
      modelId: "test",
      stream: true,
      options: {},
      context: {
        messages: [{ role: "user", content: "PLEASE IMPLEMENT THIS PLAN", timestamp: 0 }],
        tools: [],
      },
    };
    expect(PlanModeDetector.isImplementingPlanRequest(mockImplementing)).toBe(true);

    const mockNormal: CodexParsedRequest = {
      modelId: "test",
      stream: true,
      options: {},
      context: {
        messages: [{ role: "user", content: "Hãy viết code đi", timestamp: 0 }],
        tools: [],
      },
    };
    expect(PlanModeDetector.isImplementingPlanRequest(mockNormal)).toBe(false);
  });

  test("BasePromptCompiler: compile đầy đủ 4 phần ở lượt đầu tiên (isNewConversation = true)", () => {
    const compiler = new BasePromptCompiler();
    const result = compiler.compile({
      normalized: sampleNormalized,
      isNewConversation: true,
    });

    expect(result.finalPrompt).toContain("# PHẦN 1: GIAO THỨC GIAO TIẾP VỚI IDE");
    expect(result.finalPrompt).toContain("# PHẦN 2: BẢNG KHAI BÁO CÔNG CỤ HIỆN HÀNH");
    expect(result.finalPrompt).toContain("# PHẦN 3: BỐI CẢNH DỰ ÁN VÀ QUY TẮC PHÁT TRIỂN");
    expect(result.finalPrompt).toContain("# PHẦN 4: NHIỆM VỤ NGƯỜI DÙNG VÀ YÊU CẦU THỰC THI");
    expect(result.finalPrompt).toContain("exec_command");
    expect(result.finalPrompt).toContain("apply_patch");
    expect(result.finalPrompt).toContain("Tuân thủ nguyên tắc SOLID.");
    expect(result.collaborationMode).toBe("default");
    expect(result.isPlanMode).toBe(false);
  });

  test("BasePromptCompiler: compile incremental delta ở lượt tiếp theo (isNewConversation = false)", () => {
    const compiler = new BasePromptCompiler();
    const result = compiler.compile({
      normalized: sampleNormalized,
      isNewConversation: false,
    });

    expect(result.finalPrompt).toContain("# THỰC THI NHIỆM VỤ TIẾP THEO (STATEFUL INCREMENTAL TURN)");
    expect(result.finalPrompt).toContain("CODEX ACTION CONTRACT FOR THIS IDE TURN (COMPACT)");
    expect(result.finalPrompt).toContain("Process exited with code 0");
    expect(result.finalPrompt).not.toContain("# PHẦN 1: GIAO THỨC");
  });

  test("BasePromptAssembler: assemble prompt hợp lệ từ parsed request", () => {
    const assembler = new BasePromptAssembler();
    const parsed: CodexParsedRequest = {
      modelId: "test",
      stream: true,
      options: {},
      context: {
        messages: [
          { role: "user", content: "Hãy kiểm tra thư mục", timestamp: 0 },
          { role: "assistant", content: [{ type: "text", text: "Tôi đang kiểm tra" }], timestamp: 0 },
        ],
        tools: [],
      },
    };

    const assembled = assembler.assemble(parsed, true);
    expect(assembled).toContain(UNIFIED_TOOL_PROTOCOL);
    expect(assembled).toContain("Hãy kiểm tra thư mục");
    expect(assembled).toContain("Tôi đang kiểm tra");
  });
});
