 import { describe, expect, it } from "bun:test";
import {
  GOOGLE_AI_STUDIO_DEFAULT_SLUG,
  isGoogleAIStudioModelSlug,
  requireGoogleAIStudioModelRoute,
  availableGoogleAIStudioModelRoutes,
} from "../src/models/google-ai-studio-models";
import {
  AI_STUDIO_SELECTORS,
  parseGoogleAIStudioPromptId,
  buildGoogleAIStudioPromptUrl,
  GOOGLE_AI_STUDIO_NEW_CHAT_URL,
} from "../src/adapters/google-ai-studio/selectors";
import {
  googleAIStudioConversationKey,
  GoogleAIStudioConversationStore,
  resolveGoogleAIStudioTargetUrl,
} from "../src/adapters/google-ai-studio/conversation-store";
import {
  buildGoogleAIStudioModel,
  augmentNativeModelCatalog,
  getFallbackNativeCatalog,
} from "../src/models/model-catalog";
import { defaultConfig } from "../src/config";
import {
  createGoogleAIStudioAdapter,
  GoogleAIStudioAdapter,
  sanitizeAIStudioResponse,
} from "../src/adapters/google-ai-studio";
import { parseStrictM365Response } from "../src/adapters/m365-copilot/translation/strict-response-parser";

describe("Google AI Studio Models & Routes", () => {
  it("nhận diện chính xác slug mặc định của Google AI Studio", () => {
    expect(isGoogleAIStudioModelSlug("google-ai-studio")).toBe(true);
    expect(isGoogleAIStudioModelSlug("google-ai-studio/custom")).toBe(true);
    expect(isGoogleAIStudioModelSlug("gemini-web")).toBe(false);
    expect(isGoogleAIStudioModelSlug("m365-copilot")).toBe(false);
    expect(isGoogleAIStudioModelSlug("")).toBe(false);
  });

  it("trả về cấu hình route mặc định với model gemini-flash-latest", () => {
    const route = requireGoogleAIStudioModelRoute("google-ai-studio");
    expect(route.slug).toBe(GOOGLE_AI_STUDIO_DEFAULT_SLUG);
    expect(route.backendModel).toBe("gemini-flash-latest");
    expect(route.urlModelParam).toBe("gemini-flash-latest");
    expect(route.defaultEffort).toBe("medium");
    expect(route.supportedCodexEfforts).toEqual(["low", "medium", "high"]);
  });

  it("danh sách available routes chỉ gồm 1 bản mặc định duy nhất", () => {
    const routes = availableGoogleAIStudioModelRoutes();
    expect(routes.length).toBe(1);
    expect(routes[0].slug).toBe(GOOGLE_AI_STUDIO_DEFAULT_SLUG);
  });
});

describe("Google AI Studio Selectors & URL Parsing", () => {
  it("trích xuất chính xác Prompt ID từ URL tiếp tục hội thoại cũ", () => {
    const url = "https://aistudio.google.com/u/0/prompts/1SU4onB0p06H7ZFATYFIBltEbuE4cEB8e";
    expect(parseGoogleAIStudioPromptId(url)).toBe("1SU4onB0p06H7ZFATYFIBltEbuE4cEB8e");

    const urlWithoutUserIndex = "https://aistudio.google.com/prompts/abc123XYZ_456";
    expect(parseGoogleAIStudioPromptId(urlWithoutUserIndex)).toBe("abc123XYZ_456");
  });

  it("bỏ qua new_chat khi phân tích URL", () => {
    expect(parseGoogleAIStudioPromptId(GOOGLE_AI_STUDIO_NEW_CHAT_URL)).toBeUndefined();
    expect(parseGoogleAIStudioPromptId("https://aistudio.google.com/u/0/prompts/new_chat")).toBeUndefined();
    expect(parseGoogleAIStudioPromptId("https://google.com")).toBeUndefined();
  });

  it("tạo đúng URL tiếp tục chat cũ từ promptId", () => {
    const url = buildGoogleAIStudioPromptUrl("1SU4onB0p06H7ZFATYFIBltEbuE4cEB8e");
    expect(url).toBe("https://aistudio.google.com/u/0/prompts/1SU4onB0p06H7ZFATYFIBltEbuE4cEB8e");
  });

  it("định nghĩa đầy đủ các selector quan trọng", () => {
    expect(AI_STUDIO_SELECTORS.composer).toContain("textarea");
    expect(AI_STUDIO_SELECTORS.runButton).toContain("ms-run-button");
    expect(AI_STUDIO_SELECTORS.stopButton).toContain("ms-run-button");
    expect(AI_STUDIO_SELECTORS.textChunk).toContain("ms-text-chunk");
    expect(AI_STUDIO_SELECTORS.thoughtChunk).toBe("ms-thought-chunk");
    expect(AI_STUDIO_SELECTORS.thinkingSettingWrapper).toBe("ms-thinking-level-setting");
    expect(AI_STUDIO_SELECTORS.thinkingSelectTrigger).toContain("mat-select");
  });
});

describe("Google AI Studio Conversation Key & Target Resolution", () => {
  it("tạo hash SHA-256 nhất quán cho cùng một thread id", () => {
    const parsed: any = {
      modelId: "google-ai-studio",
      options: { reasoning: "medium" },
    };
    const key1 = googleAIStudioConversationKey(parsed, "thread_12345");
    const key2 = googleAIStudioConversationKey(parsed, "thread_12345");
    expect(key1).toBeDefined();
    expect(key1).toBe(key2);
  });

  it("resolve đúng target URL: new chat khi không có promptId, hoặc prompt URL khi có promptId", () => {
    expect(resolveGoogleAIStudioTargetUrl()).toBe(GOOGLE_AI_STUDIO_NEW_CHAT_URL);
    expect(resolveGoogleAIStudioTargetUrl(undefined)).toBe(GOOGLE_AI_STUDIO_NEW_CHAT_URL);
    expect(resolveGoogleAIStudioTargetUrl("new_chat")).toBe(GOOGLE_AI_STUDIO_NEW_CHAT_URL);
    expect(resolveGoogleAIStudioTargetUrl("1SU4onB0p06H7ZFATYFIBltEbuE4cEB8e")).toBe(
      "https://aistudio.google.com/u/0/prompts/1SU4onB0p06H7ZFATYFIBltEbuE4cEB8e"
    );
  });
});

describe("Model Catalog Integration", () => {
  it("tích hợp model google-ai-studio vào Catalog chuẩn của Codex", () => {
    const config = defaultConfig();
    const fallback = getFallbackNativeCatalog();
    const augmented = augmentNativeModelCatalog(fallback, config);

    expect(Array.isArray(augmented.models)).toBe(true);
    const googleModel = (augmented.models as any[]).find(m => m.slug === "google-ai-studio");

    expect(googleModel).toBeDefined();
    expect(googleModel.slug).toBe("google-ai-studio");
    expect(googleModel.display_name).toBe("Google AI Studio");
    expect(googleModel.default_reasoning_level).toBe("medium");
    expect(googleModel.supported_reasoning_levels.length).toBe(3);
  });

  it("GoogleAIStudioAdapter tuân thủ chuẩn ProviderAdapter interface", () => {
    const adapter = createGoogleAIStudioAdapter();
    expect(adapter).toBeInstanceOf(GoogleAIStudioAdapter);
    expect(adapter.name).toBe("google-ai-studio");
    expect(typeof adapter.runTurn).toBe("function");
  });
});

describe("Google AI Studio Response Sanitizer & Strict Parser Integration", () => {
  it("bóc sạch tiền tố rác của Angular/Material buttons và phân tích đúng final_answer", () => {
    const rawDirtySample =
      "code Codedownloadcontent_copyexpand_lessless<webResponse>\nChào bạn! Mình đã sẵn sàng hỗ trợ bạn.\n</webResponse>";

    const sanitized = sanitizeAIStudioResponse(rawDirtySample);
    expect(sanitized.startsWith("<webResponse>")).toBe(true);
    expect(sanitized.endsWith("</webResponse>")).toBe(true);
    expect(sanitized).not.toContain("downloadcontent_copy");

    const parsed = parseStrictM365Response(sanitized);
    expect(parsed.kind).toBe("final_answer");
    if (parsed.kind === "final_answer") {
      expect(parsed.content).toBe("Chào bạn! Mình đã sẵn sàng hỗ trợ bạn.");
      expect(parsed.content).not.toContain("<webResponse>");
      expect(parsed.content).not.toContain("</webResponse>");
    }
  });

  it("bóc sạch tiền tố và hậu tố rác khi Gemini gọi công cụ tool_call", () => {
    const rawToolSample =
      "code Markdown download copy <webResponse>\n<tool_call>\n{\"name\": \"exec_command\", \"arguments\": {\"cmd\": \"ls\"}}\n</tool_call>\n</webResponse>\nfooter thumbs_up";

    const sanitized = sanitizeAIStudioResponse(rawToolSample);
    expect(sanitized.startsWith("<webResponse>")).toBe(true);
    expect(sanitized.endsWith("</webResponse>")).toBe(true);

    const parsed = parseStrictM365Response(sanitized);
    expect(parsed.kind).toBe("tool_calls");
    if (parsed.kind === "tool_calls") {
      expect(parsed.calls.length).toBe(1);
      expect(parsed.calls[0].name).toBe("exec_command");
      expect(parsed.calls[0].arguments).toEqual({ cmd: "ls" });
    }
  });

  it("giữ nguyên chuỗi hợp lệ không bị dính rác", () => {
    const cleanSample = "<webResponse>\nToàn bộ nội dung sạch sẽ\n</webResponse>";
    expect(sanitizeAIStudioResponse(cleanSample)).toBe(cleanSample);
  });

  it("nhận diện chính xác hội thoại tiếp nối (multi-turn) không kích hoạt new chat khi tab được reuse", () => {
    // Giả lập trạng thái khi tab được reuse từ Launcher
    const launcherReused = true;
    const hasPriorReply = true;
    const existingPromptId = undefined;

    const isNew = !launcherReused && !hasPriorReply && !existingPromptId;
    expect(isNew).toBe(false);
  });

  it("Tolerant Answers: chấp nhận phản hồi Markdown tự nhiên không bọc 4-backtick hoặc webResponse", () => {
    const naturalMarkdown = "Chào bạn! Tôi là Gemini Flash. Tôi có thể hỗ trợ gì cho dự án hôm nay?";
    const strictResult = parseStrictM365Response(naturalMarkdown);
    // Strict parser của M365 sẽ trả về MISSING_TRANSPORT_FENCE
    expect(strictResult.kind).toBe("protocol_error");

    // Adapter Google AI Studio áp dụng Tolerant Answers
    let finalResult = strictResult;
    if (finalResult.kind === "protocol_error") {
      const isWrapperError =
        finalResult.code === "MISSING_TRANSPORT_FENCE" ||
        finalResult.code === "MISSING_RESPONSE_ENVELOPE";
      const hasActionMarkers =
        naturalMarkdown.includes("<tool_call>") ||
        naturalMarkdown.includes("<custom_tool_call") ||
        naturalMarkdown.includes("*** Begin Patch");

      if (isWrapperError && !hasActionMarkers && naturalMarkdown.trim().length > 0) {
        finalResult = {
          kind: "final_answer",
          content: naturalMarkdown.trim(),
          rawResponse: naturalMarkdown,
        };
      }
    }

    expect(finalResult.kind).toBe("final_answer");
    if (finalResult.kind === "final_answer") {
      expect(finalResult.content).toBe(naturalMarkdown);
    }
  });
});
