import { describe, expect, test } from "bun:test";
import {
  buildGeminiConversationUrl,
  GEMINI_HOME_URL,
  GeminiAdapter,
  geminiConversationKey,
  createGeminiAdapter,
  isGeminiAuthUrl,
  normalizeGeminiConversationId,
  parseGeminiConversationId,
} from "../src/adapters/gemini";
import type { WebProviderDefinition } from "../src/adapters/web/definition";
import { WebTurnEngine } from "../src/adapters/web/engine";
import type { CodexParsedRequest } from "../src/types";

function makeParsedRequest(
  overrides: Partial<CodexParsedRequest> = {},
): CodexParsedRequest {
  return {
    modelId: "gemini",
    stream: true,
    options: { reasoning: "medium" },
    context: {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello Gemini" }],
          timestamp: 1_700_000_000_000,
        },
      ],
      tools: [],
    },
    ...overrides,
  };
}

function getDefinition(adapter: GeminiAdapter): WebProviderDefinition {
  const engine = (adapter as unknown as { engine: WebTurnEngine }).engine;
  return (engine as unknown as { definition: WebProviderDefinition }).definition;
}

describe("GeminiAdapter contract & URL helpers", () => {
  test("parse, normalize và build Gemini conversation URL hỗ trợ cả /app/{id} và /u/{n}/app/{id}", () => {
    const sampleId = "722895cc1dfdbb27";
    expect(normalizeGeminiConversationId(sampleId)).toBe(sampleId);
    expect(normalizeGeminiConversationId("new")).toBeUndefined();
    expect(normalizeGeminiConversationId("gems")).toBeUndefined();
    expect(normalizeGeminiConversationId("settings")).toBeUndefined();
    expect(
      parseGeminiConversationId(`https://gemini.google.com/app/${sampleId}`),
    ).toBe(sampleId);
    expect(
      parseGeminiConversationId(`https://gemini.google.com/u/0/app/${sampleId}`),
    ).toBe(sampleId);
    expect(
      parseGeminiConversationId(`https://evil.example.com/app/${sampleId}`),
    ).toBeUndefined();
    expect(buildGeminiConversationUrl(sampleId)).toBe(
      `https://gemini.google.com/app/${sampleId}`,
    );
    expect(isGeminiAuthUrl("https://accounts.google.com/ServiceLogin")).toBe(true);
    expect(isGeminiAuthUrl("https://gemini.google.com/app")).toBe(false);
  });

  test("geminiConversationKey tạo SHA-256 hex ổn định theo threadId và giữ nguyên khi đổi model/reasoning cùng provider", () => {
    const keyA = geminiConversationKey(
      makeParsedRequest({ modelId: "gemini/4-hydrogen", options: { reasoning: "medium" } }),
      "thread_secret_123",
    );
    const keyB = geminiConversationKey(
      makeParsedRequest({ modelId: "gemini/4-neon", options: { reasoning: "high" } }),
      "thread_secret_123",
    );
    const keyOtherThread = geminiConversationKey(
      makeParsedRequest({ modelId: "gemini/4-hydrogen", options: { reasoning: "medium" } }),
      "thread_secret_456",
    );

    expect(keyA).toMatch(/^[a-f0-9]{64}$/);
    expect(keyA).toBe(keyB);
    expect(keyA).not.toBe(keyOtherThread);
    expect(keyA).not.toContain("thread_secret_123");
  });

  test("resolveState vẫn đánh dấu isNewConversation=true khi chưa có tab/link web dù Codex đã có lịch sử", () => {
    const adapter = createGeminiAdapter() as GeminiAdapter;
    const def = getDefinition(adapter);
    const resolved = def.conversation.resolveState?.({
      parsed: makeParsedRequest(),
      incoming: { headers: new Headers() },
      leaseConversationId: undefined,
      launcherReused: false,
      hasPriorAssistantReply: true,
    });
    expect(resolved).toEqual({
      existingConversationId: undefined,
      isNewConversation: true,
    });
  });

  test("WebProviderDefinition tuân thủ fail-closed, ephemeral json_schema retain=false, max 3 images", () => {
    const adapter = createGeminiAdapter() as GeminiAdapter;
    const def = getDefinition(adapter);

    expect(def.id).toBe("gemini");
    expect(def.assistantName).toBe("Gemini");
    expect(def.browser.launcherProviderId).toBe("gemini");
    expect(def.browser.connectorIdentity).toBe("gemini");
    expect(def.policies?.launcherFailureMode).toBe("fail-closed");
    expect(def.policies?.enableEarlyExitOnFinalAnswer).toBe(true);
    expect(def.policies?.enableToolLoopGuard).toBe(true);
    expect(def.policies?.maxPromptChars).toBe(120_000);
    expect(def.attachments?.maxInputImages).toBe(3);

    expect(
      def.browser.resolveInitialUrl?.({
        modelId: "gemini",
        existingConversationId: undefined,
      }),
    ).toBe(GEMINI_HOME_URL);
    expect(
      def.browser.resolveInitialUrl?.({
        modelId: "gemini",
        existingConversationId: "722895cc1dfdbb27",
      }),
    ).toBe("https://gemini.google.com/app/722895cc1dfdbb27");

    const jsonSchemaParsed = makeParsedRequest({
      options: {
        outputFormat: {
          type: "json_schema",
          name: "title_schema",
          strict: true,
          schema: { type: "object", properties: { title: { type: "string" } } },
        },
      },
    });
    expect(
      def.conversation.resolveEndTurnBinding?.({
        finalStatus: "completed",
        activeConversationId: "722895cc1dfdbb27",
        parsed: jsonSchemaParsed,
        hasPriorAssistantReply: false,
        hasToolResults: false,
      }),
    ).toEqual({ connectorBound: false, retain: false });

    expect(
      def.conversation.resolveEndTurnBinding?.({
        finalStatus: "completed",
        activeConversationId: "722895cc1dfdbb27",
        parsed: makeParsedRequest(),
        hasPriorAssistantReply: false,
        hasToolResults: false,
      }),
    ).toEqual({
      connectorBound: true,
      conversationId: "722895cc1dfdbb27",
      retain: true,
    });

    const attachmentsAttempt0 = def.attachments?.extractAttachments?.({
      parsed: makeParsedRequest(),
      attempt: 0,
      normalized: {
        prompt: "hi",
        images: [{ name: "a.png", mimeType: "image/png", buffer: Buffer.from("a") }],
      } as never,
    });
    const attachmentsAttempt1 = def.attachments?.extractAttachments?.({
      parsed: makeParsedRequest(),
      attempt: 1,
      normalized: {
        prompt: "hi",
        images: [{ name: "a.png", mimeType: "image/png", buffer: Buffer.from("a") }],
      } as never,
    });
    expect(attachmentsAttempt0).toHaveLength(1);
    expect(attachmentsAttempt1).toEqual([]);
  });
});
