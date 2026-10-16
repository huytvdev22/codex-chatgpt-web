import { describe, expect, test } from "bun:test";
import {
  isChatGptWebModelSlug,
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_MODEL_ROUTES,
} from "../src/chatgpt-web-models";
import { CHATGPT_SELECTORS } from "../src/adapters/chatgpt-web/selectors";
import {
  buildUnifiedToolProtocol,
  buildShortOutputFormatAnchor,
} from "../src/adapters/m365-copilot/prompts";
import {
  ChatGptWebAdapter,
  createChatGptWebAdapter,
  resolveChatGptEffort,
  chatGptWebTraceId,
} from "../src/adapters/chatgpt-web";
import { ensureMarkdownTransportFence } from "../src/adapters/chatgpt-web/chatgpt-browser-worker";
import { parseStrictM365Response } from "../src/adapters/m365-copilot/translation/strict-response-parser";
import { normalizeM365ToolArguments } from "../src/adapters/m365-copilot/tools/argument-normalizer";
import { validateM365ToolCall } from "../src/adapters/m365-copilot/tools/tool-validator";
import { M365ToolBridge } from "../src/adapters/m365-copilot/tools/tool-bridge";
import { hasActualPriorAssistantReply } from "../src/adapters/base";
import { M365PromptCompiler } from "../src/adapters/m365-copilot/prompts";
import { CodexPayloadNormalizer, CodexRawPayload } from "../src/adapters/m365-copilot/normalization";

describe("ChatGPT Web Adapter Base Architecture Tests", () => {
  test("1. isChatGptWebModelSlug nhận diện chính xác các model của ChatGPT Web", () => {
    expect(isChatGptWebModelSlug("chatgpt-web")).toBe(true);
    expect(isChatGptWebModelSlug("chatgpt-web/pro")).toBe(true);
    expect(isChatGptWebModelSlug("chatgpt-web/gpt-5.6-sol")).toBe(true);
    expect(isChatGptWebModelSlug("chatgpt-web/gpt-5-luna")).toBe(true);
    expect(isChatGptWebModelSlug("chatgpt-web/auto")).toBe(true);

    // Không nhận nhầm các adapter khác
    expect(isChatGptWebModelSlug("m365-copilot")).toBe(false);
    expect(isChatGptWebModelSlug("gemini-web")).toBe(false);
    expect(isChatGptWebModelSlug("gpt-5")).toBe(false);
  });

  test("2. availableChatGptWebModelRoutes cung cấp đầy đủ danh sách model routes", () => {
    const routes = availableChatGptWebModelRoutes({ solAvailable: true, proAvailable: true });
    expect(routes.length).toBeGreaterThanOrEqual(3);
    const proRoute = routes.find(r => r.slug === "chatgpt-web/gpt-5.6-pro");
    expect(proRoute).toBeDefined();
    expect((proRoute as any)?.modelFamily).toBe("5.6");
  });

  test("3. resolveChatGptEffort phân giải chính xác reasoning effort", () => {
    expect(resolveChatGptEffort("chatgpt-web/pro", "low")).toBe("low");
    expect(resolveChatGptEffort("chatgpt-web/pro", "medium")).toBe("medium");
    expect(resolveChatGptEffort("chatgpt-web/pro", "high")).toBe("high");
    expect(resolveChatGptEffort("chatgpt-web/pro", "xhigh")).toBe("xhigh");
    expect(resolveChatGptEffort("chatgpt-web/pro", "max")).toBe("max");
    // Fallback mặc định
    expect(resolveChatGptEffort("chatgpt-web/pro", undefined)).toBe("medium");
    expect(resolveChatGptEffort("chatgpt-web/pro", "invalid")).toBe("medium");
  });

  test("4. CHATGPT_SELECTORS khai báo đầy đủ các element DOM cốt lõi của chatgpt.com", () => {
    expect(CHATGPT_SELECTORS.appUrl).toBe("https://chatgpt.com/?temporary-chat=true");
    expect(CHATGPT_SELECTORS.composerInput).toBeDefined();
    expect(CHATGPT_SELECTORS.sendButton).toBeDefined();
    expect(CHATGPT_SELECTORS.stopButton).toBeDefined();
    expect(CHATGPT_SELECTORS.responseContainer).toBeDefined();
    expect(CHATGPT_SELECTORS.modelSelectorButton).toBeDefined();
    expect(CHATGPT_SELECTORS.codeCopyButton).toBeDefined();
    expect(CHATGPT_SELECTORS.completionAction).toBeDefined();
  });

  test("5. buildUnifiedToolProtocol hỗ trợ sinh prompt chuẩn hóa cho ChatGPT với thẻ webResponse", () => {
    const chatGptPrompt = buildUnifiedToolProtocol("ChatGPT");
    expect(chatGptPrompt).toContain("Chào ChatGPT, mình đang làm việc trên một dự án phần mềm ở máy cá nhân");
    expect(chatGptPrompt).toContain("<webResponse>");
    expect(chatGptPrompt).toContain("apply_patch");

    const anchor = buildShortOutputFormatAnchor();
    expect(anchor).toContain("<webResponse>");
    expect(anchor).toContain("4-backtick");
  });

  test("6. ChatGptWebAdapter khởi tạo chuẩn ProviderAdapter interface", () => {
    const adapter = createChatGptWebAdapter({ headless: true });
    expect(adapter).toBeInstanceOf(ChatGptWebAdapter);
    expect(adapter.name).toBe("chatgpt-web");
  });

  test("7. chatGptWebTraceId tạo traceId hợp lệ", () => {
    const headers = new Headers();
    headers.set("x-codex-trace-id", "trace-test-123");
    expect(chatGptWebTraceId(headers)).toBe("trace-test-123");

    const generated = chatGptWebTraceId();
    expect(generated.startsWith("chatgpt_trace_")).toBe(true);
  });

  test("8. Bóc tách và parse strict response từ khối Markdown của ChatGPT Web", () => {
    // Giả lập raw text trích xuất từ nút 'Copy code' hoặc DOM của ChatGPT Web
    const chatGptCodeBlockContent = `<webResponse>
Chào bạn! Mình là ChatGPT, đã sẵn sàng hỗ trợ bạn phát triển dự án.

Bạn muốn bắt đầu kiểm tra phần nào trước?
</webResponse>`;

    const wrapped = ensureMarkdownTransportFence(chatGptCodeBlockContent);
    expect(wrapped.startsWith("````markdown")).toBe(true);
    expect(wrapped.endsWith("````")).toBe(true);

    const parsed = parseStrictM365Response(wrapped);
    expect(parsed.kind).toBe("final_answer");
    if (parsed.kind === "final_answer") {
      expect(parsed.content).toContain("Chào bạn! Mình là ChatGPT, đã sẵn sàng hỗ trợ bạn phát triển dự án.");
      expect(parsed.content).not.toContain("<webResponse>");
      expect(parsed.content).not.toContain("</webResponse>");
    }

    // Giả lập tool call qua strict-parser
    const chatGptToolContent = `<webResponse>
<tool_call>
{"name": "read_file", "arguments": {"path": "package.json"}}
</tool_call>
</webResponse>`;

    const toolWrapped = ensureMarkdownTransportFence(chatGptToolContent);
    const parsedTool = parseStrictM365Response(toolWrapped);
    expect(parsedTool.kind).toBe("tool_calls");
    if (parsedTool.kind === "tool_calls") {
      expect(parsedTool.calls).toHaveLength(1);
      expect(parsedTool.calls[0].name).toBe("read_file");
      expect(parsedTool.calls[0].arguments).toEqual({ path: "package.json" });
    }
  });

  test("9. Chuẩn hóa alias execute_command sang exec_command và map tool thành công", () => {
    const rawCall = {
      name: "execute_command",
      arguments: { command: "git status" },
    };

    const normalized = normalizeM365ToolArguments(rawCall.name, rawCall.arguments);
    expect(normalized.name).toBe("exec_command");
    expect(normalized.arguments.cmd).toBe("git status");

    const clientTools = [{ name: "exec_command", description: "Run CLI command", parameters: {} }];
    const validation = validateM365ToolCall(normalized.name, normalized.arguments, clientTools as any);
    expect(validation.ok).toBe(true);

    const mapped = M365ToolBridge.mapToolCall(rawCall, clientTools as any);
    expect(mapped.name).toBe("exec_command");
    const mappedArgs = JSON.parse(mapped.arguments);
    expect(mappedArgs.cmd).toBe("git status");
  });

  test("10. hasActualPriorAssistantReply phân biệt chính xác placeholder rỗng với phản hồi trợ lý thực tế", () => {
    // Không có assistant
    expect(hasActualPriorAssistantReply([])).toBe(false);
    expect(hasActualPriorAssistantReply([{ role: "user", content: "xin chào" }])).toBe(false);

    // Placeholder rỗng do parser tạo hoặc context Codex gửi
    expect(hasActualPriorAssistantReply([
      { role: "assistant", content: [] },
      { role: "user", content: "xin chào" },
    ])).toBe(false);

    expect(hasActualPriorAssistantReply([
      { role: "assistant", content: "" },
      { role: "user", content: "xin chào" },
    ])).toBe(false);

    expect(hasActualPriorAssistantReply([
      { role: "assistant", content: [{ type: "text", text: "   " }] },
      { role: "user", content: "xin chào" },
    ])).toBe(false);

    // Trợ lý đã thực sự trả lời có nội dung
    expect(hasActualPriorAssistantReply([
      { role: "assistant", content: "Chào bạn, mình có thể giúp gì?" },
      { role: "user", content: "xin chào" },
    ])).toBe(true);

    expect(hasActualPriorAssistantReply([
      { role: "assistant", content: [{ type: "text", text: "Chào bạn" }] },
      { role: "user", content: "xin chào" },
    ])).toBe(true);

    expect(hasActualPriorAssistantReply([
      { role: "assistant", content: [{ type: "toolCall", name: "exec_command", id: "call_1" }] },
      { role: "user", content: "xin chào" },
    ])).toBe(true);
  });

  test("11. Lượt mở đầu (New Chat) luôn gửi trọn vẹn bootstrap handshake buildUnifiedToolProtocol dù context có placeholder rỗng", () => {
    const rawCodexInput = {
      model: "chatgpt-web/pro",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "You are Codex..." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "xin chào" }],
        },
      ],
    };

    const rawPayload = CodexRawPayload.from(rawCodexInput);
    const normalized = CodexPayloadNormalizer.normalize(rawPayload);

    // Giả lập messages chứa placeholder trợ lý rỗng
    const parsed = {
      modelId: "chatgpt-web/pro",
      options: {},
      context: {
        messages: [
          { role: "developer", content: "You are Codex..." },
          { role: "assistant", content: [] }, // placeholder rỗng
          { role: "user", content: "xin chào" },
        ],
      },
    };

    const isNew = !hasActualPriorAssistantReply(parsed.context.messages);
    expect(isNew).toBe(true);

    const compiler = new M365PromptCompiler({ assistantName: "ChatGPT" });
    const res = compiler.compile({
      normalized,
      parsed: parsed as any,
      isNewConversation: isNew,
      assistantName: "ChatGPT",
    });

    // BẮT BUỘC có câu mở đầu thỏa thuận bắt tay
    expect(res.finalPrompt).toContain("Chào ChatGPT, mình đang làm việc trên một dự án phần mềm ở máy cá nhân");
    // BẮT BUỘC có danh sách công cụ
    expect(res.finalPrompt).toContain("[DANH SÁCH CÔNG CỤ MÁY MÌNH HỖ TRỢ CHO BẠN Ở LƯỢT NÀY]");
    // BẮT BUỘC có nội dung người dùng
    expect(res.finalPrompt).toContain("xin chào");
    // BẮT BUỘC có mỏ neo định dạng chốt hạ
    expect(res.finalPrompt).toContain("Nhắc nhẹ định dạng để script của mình đọc không bị vấp nhé:");
  });
});

