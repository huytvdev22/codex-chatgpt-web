import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { M365BrowserWorker, M365CopilotAdapter } from "../src/adapters/m365-copilot";
import { WebTurnEngine } from "../src/adapters/web";
import { compileWebPrompt } from "../src/adapters/web/compile-prompt";
import { buildFormatRetryPrompt } from "../src/adapters/web/prompt";
import { parseAndValidateJsonSchemaResponse } from "../src/adapters/web/protocol";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

const TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
  },
  required: ["title", "description"],
  additionalProperties: false,
} as const;

function createStructuredRequest(overrides: Record<string, unknown> = {}): CodexParsedRequest {
  return parseRequest({
    model: "m365-copilot/gpt-5.4",
    instructions:
      "You are a helpful assistant. Provide a short UI title (up to 36 characters) and description.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix bug auto-close tab in Electron launcher" }],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "task_title",
        strict: true,
        schema: TITLE_SCHEMA,
      },
    },
    ...overrides,
  });
}

describe("Web Adapter Structured Output (json_schema) & Ephemeral Utility Tab", () => {
  test("Phase 1: compileWebPrompt dùng prompt Structured JSON gọn nhẹ, không chèn bridge tool protocol", () => {
    const parsed = createStructuredRequest({
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run shell command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply patch",
        },
      ],
    });

    const compiled = compileWebPrompt(parsed, {
      assistantName: "M365",
      isNewConversation: true,
    });

    expect(compiled.finalPrompt).toContain('JSON Schema "task_title" (strict=true)');
    expect(compiled.finalPrompt).toContain('"title"');
    expect(compiled.finalPrompt).toContain('"description"');
    expect(compiled.finalPrompt).toContain("Fix bug auto-close tab in Electron launcher");
    expect(compiled.finalPrompt).not.toContain("<webResponse>");
    expect(compiled.finalPrompt).not.toContain("<tool_call>");
    expect(compiled.finalPrompt).not.toContain("apply_patch");
    expect(compiled.finalPrompt).not.toContain("script cầu nối tự động");
  });

  test("Phase 2: parseAndValidateJsonSchemaResponse bóc JSON thuần, fenced block, webResponse và chuẩn hóa 1 dòng", () => {
    const format = {
      type: "json_schema" as const,
      name: "task_title",
      strict: true,
      schema: TITLE_SCHEMA,
    };

    const rawJson = parseAndValidateJsonSchemaResponse(
      '{"title":"Sửa lỗi đóng tab","description":"Đóng tab phụ sau khi sinh tiêu đề"}',
      format,
    );
    expect(rawJson.kind).toBe("final_answer");
    if (rawJson.kind === "final_answer") {
      expect(JSON.parse(rawJson.content)).toEqual({
        title: "Sửa lỗi đóng tab",
        description: "Đóng tab phụ sau khi sinh tiêu đề",
      });
    }

    const wrapped = parseAndValidateJsonSchemaResponse(
      '````markdown\n<webResponse>\n```json\n{\n  "title": "Fix M365 tab close",\n  "description": "Close title tab on completion"\n}\n```\n</webResponse>\n````',
      format,
    );
    expect(wrapped.kind).toBe("final_answer");
    if (wrapped.kind === "final_answer") {
      expect(wrapped.content).toBe(
        '{"title":"Fix M365 tab close","description":"Close title tab on completion"}',
      );
    }

    const withProsePrefix = parseAndValidateJsonSchemaResponse(
      'Dưới đây là tiêu đề gợi ý:\n{"title":"Tối ưu json_schema","description":"Bỏ tool protocol ở lượt sinh tiêu đề"}',
      format,
    );
    expect(withProsePrefix.kind).toBe("final_answer");
  });

  test("Phase 2: parseAndValidateJsonSchemaResponse từ chối YAML, thiếu trường hoặc thừa field ngoài schema", () => {
    const format = {
      type: "json_schema" as const,
      name: "task_title",
      strict: true,
      schema: TITLE_SCHEMA,
    };

    const yamlResult = parseAndValidateJsonSchemaResponse(
      "title: Fix tab close\ndescription: Auto close helper tab",
      format,
    );
    expect(yamlResult.kind).toBe("protocol_error");
    if (yamlResult.kind === "protocol_error") {
      expect(yamlResult.code).toBe("INVALID_JSON_SCHEMA_OUTPUT");
    }

    const missingField = parseAndValidateJsonSchemaResponse(
      '{"title":"Thiếu description"}',
      format,
    );
    expect(missingField.kind).toBe("protocol_error");
    if (missingField.kind === "protocol_error") {
      expect(missingField.code).toBe("INVALID_JSON_SCHEMA_OUTPUT");
      expect(missingField.message).toContain("description");
    }

    const extraField = parseAndValidateJsonSchemaResponse(
      '{"title":"OK","description":"Valid","extra":true}',
      format,
    );
    expect(extraField.kind).toBe("protocol_error");
    if (extraField.kind === "protocol_error") {
      expect(extraField.code).toBe("INVALID_JSON_SCHEMA_OUTPUT");
      expect(extraField.message).toContain("extra");
    }

    const retryPrompt = buildFormatRetryPrompt({
      code: "INVALID_JSON_SCHEMA_OUTPUT",
      message: "Thiếu trường description",
      outputFormat: format,
    });
    expect(retryPrompt).toContain('JSON Schema "task_title"');
    expect(retryPrompt).toContain("KHÔNG viết YAML");
    expect(retryPrompt).not.toContain("<custom_tool_call");
  });

  test("Phase 2 + 3: WebTurnEngine tự retry khi YAML sai schema rồi phát JSON sạch và đóng tab với retain=false", async () => {
    const events: AdapterEvent[] = [];
    const seenPrompts: string[] = [];
    const seenRetainFlags: Array<boolean | undefined> = [];
    let capturedEndActivity: any = null;
    let attemptCounter = 0;

    const engine = new WebTurnEngine(
      {
        id: "m365-copilot",
        assistantName: "M365",
        logPrefix: "m365-adapter",
        policies: {
          maxFormatRetries: 2,
          rethrowError: true,
        },
        conversation: {
          resolveConversationKey: ({ turnTraceId }) => `ephemeral-${turnTraceId}`,
          resolveEndTurnBinding: ({ hasPriorAssistantReply, hasToolResults }) => ({
            connectorBound: Boolean(hasPriorAssistantReply || hasToolResults),
            retain: Boolean(hasPriorAssistantReply || hasToolResults),
          }),
        },
        browser: {
          launcherProviderId: "m365",
          connectorIdentity: "m365-copilot",
          executeTurn: async input => {
            seenPrompts.push(input.prompt);
            seenRetainFlags.push(input.retain);
            attemptCounter += 1;
            if (attemptCounter === 1) {
              return {
                rawResponse: "title: Fix launcher\ndescription: YAML should trigger retry",
              };
            }
            return {
              rawResponse:
                '```json\n{"title":"Fix launcher tab","description":"Auto close M365 title tab"}\n```',
            };
          },
        },
      },
      undefined,
      {
        resolveDescriptorPath: () => "/tmp/fake-launcher.json",
        startTurn: async () => ({
          connection: {
            browser: { close: async () => {} },
            page: {} as Page,
          } as any,
          surfaceId: "s-title",
          conversationId: undefined,
          reused: false,
          connectorBound: false,
        }),
        heartbeatTurn: async () => {},
        endTurn: async ({ activity }) => {
          capturedEndActivity = activity as unknown as Record<string, unknown>;
        },
        closeTurn: async () => {},
      },
    );

    await engine.runTurn(
      createStructuredRequest(),
      { headers: new Headers() },
      event => events.push(event),
    );

    expect(attemptCounter).toBe(2);
    expect(seenPrompts[0]).not.toContain("script cầu nối tự động");
    expect(seenPrompts[1]).toContain('JSON Schema "task_title"');
    expect(seenRetainFlags).toEqual([false, false]);

    const textEvent = events.find(e => e.type === "text_delta");
    expect(textEvent).toEqual({
      type: "text_delta",
      text: '{"title":"Fix launcher tab","description":"Auto close M365 title tab"}',
    });

    expect(capturedEndActivity?.["phase"]).toBe("end");
    expect(capturedEndActivity?.["status"]).toBe("completed");
    expect(capturedEndActivity?.["retain"]).toBe(false);
    expect(capturedEndActivity?.["connectorBound"]).toBe(false);
  });

  test("Phase 3: M365CopilotAdapter cách ly key cho json_schema và M365BrowserWorker không chờ URL persistent khi retain=false", async () => {
    const adapter = new M365CopilotAdapter() as unknown as {
      definition: {
        conversation: {
          resolveConversationKey: (ctx: {
            parsed: CodexParsedRequest;
            incoming: { headers: Headers };
            threadId?: string;
            turnTraceId?: string;
          }) => string | undefined;
          resolveEndTurnBinding: (ctx: {
            finalStatus: "completed" | "failed" | "aborted";
            activeConversationId?: string;
            parsed?: CodexParsedRequest;
            hasPriorAssistantReply?: boolean;
            hasToolResults?: boolean;
          }) => { connectorBound: boolean; conversationId?: string; retain?: boolean };
        };
      };
    };

    const structuredParsed = createStructuredRequest({
      metadata: { thread_id: "thr_shared_123" },
    });
    const normalParsed = parseRequest({
      model: "m365-copilot/gpt-5.4",
      input: [{ type: "message", role: "user", content: "Hello" }],
      metadata: { thread_id: "thr_shared_123" },
    });

    const sharedHeaders = new Headers({
      "x-codex-conversation-key": "thr_shared_123",
    });
    const structuredKey = adapter.definition.conversation.resolveConversationKey({
      parsed: structuredParsed,
      incoming: { headers: sharedHeaders },
      threadId: "thr_shared_123",
      turnTraceId: "trace-title-1",
    });
    const normalKey = adapter.definition.conversation.resolveConversationKey({
      parsed: normalParsed,
      incoming: { headers: sharedHeaders },
      threadId: "thr_shared_123",
      turnTraceId: "trace-main-1",
    });

    expect(structuredKey).toMatch(/^[a-f0-9]{64}$/);
    expect(normalKey).toMatch(/^[a-f0-9]{64}$/);
    expect(structuredKey).not.toBe(normalKey);

    const ephemeralBinding = adapter.definition.conversation.resolveEndTurnBinding({
      finalStatus: "completed",
      activeConversationId: undefined,
      parsed: structuredParsed,
      hasPriorAssistantReply: false,
      hasToolResults: false,
    });
    expect(ephemeralBinding).toEqual({
      connectorBound: false,
      retain: false,
    });

    class TestEphemeralM365Worker extends M365BrowserWorker {
      protected override async navigate(): Promise<void> {}
      protected override async prepareProvider(): Promise<void> {}
      protected override async captureResponseBaseline() {
        return { messageCount: 0, lastAssistantText: "", lastAssistantId: null } as any;
      }
      protected override async insertPrompt(): Promise<void> {}
      protected override async submitPrompt(): Promise<void> {}
      protected override async waitForCompletion() {
        return {
          text: '{"title":"OK","description":"Done"}',
          isGenerating: false,
          isCompleted: true,
          timedOut: false,
          status: { hasContent: true },
        } as any;
      }
      protected override async extractCompletedResponse(): Promise<string> {
        return '{"title":"OK","description":"Done"}';
      }
    }

    const fakePage = {
      url: () => "https://m365.cloud.microsoft/chat",
    } as unknown as Page;

    const worker = new TestEphemeralM365Worker();
    const startMs = Date.now();
    const result = await worker.executeTurn(fakePage, {
      prompt: "test",
      conversationKey: structuredKey,
      retain: false,
    });
    const elapsedMs = Date.now() - startMs;

    expect(result.rawResponse).toBe('{"title":"OK","description":"Done"}');
    expect(result.conversationId).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
