import type { ProviderAdapter } from "../base";
import { promptCompiler } from "../web/prompt/index";
import { CodexRawPayload, CodexPayloadNormalizer } from "../web/normalization";
import { executeM365Turn, m365ConversationKey } from "./browser";
import { type ToolValidationFailure } from "../web/tools";
import { WebProviderAdapter } from "../web/web-provider-adapter";

export * from "../web/execution";
export * from "../web/normalization";
export * from "../web/prompt/index";
export * from "../web/protocol";
export * from "../web/tools";
export * from "../web/harness";
export * from "./browser";

function resolveM365MaxFormatRetries(): number {
  const configuredRetries = Number.parseInt(
    process.env.M365_FORMAT_MAX_RETRIES || "3",
    10,
  );
  return Number.isFinite(configuredRetries) && configuredRetries >= 0
    ? Math.min(configuredRetries, 10)
    : 3;
}

/**
 * M365 Copilot Web Adapter kế thừa WebProviderAdapter dùng chung,
 * chỉ khai báo các đặc thù riêng của M365 (conversation key, attachments, browser worker và policies).
 */
export class M365CopilotAdapter extends WebProviderAdapter {
  override readonly name = "m365-copilot";

  constructor() {
    super({
      id: "m365-copilot",
      assistantName: "M365",
      logPrefix: "m365-adapter",
      abortMessage: "M365 Copilot turn aborted before start",
      compilePrompt: (parsed, isNewConversation) => {
        const payload = CodexRawPayload.from(parsed._rawBody || parsed);
        const normalized = CodexPayloadNormalizer.normalize(payload);
        return promptCompiler.compile({
          normalized,
          parsed,
          isNewConversation,
        }).finalPrompt;
      },
      policies: {
        manageLauncherLeaseInEngine: false,
        enableEarlyExitOnFinalAnswer: true,
        enableToolLoopGuard: true,
        emitErrorEventOnFailure: true,
        errorMessagePrefix: "[M365 Copilot]",
        rethrowError: false,
        abortedTurnMessage: "M365 Copilot turn aborted",
        maxFormatRetries: resolveM365MaxFormatRetries,
      },
      conversation: {
        resolveConversationKey: ({ parsed, incoming }) => {
          const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
          const rawConversationKey =
            incoming.headers.get("x-codex-conversation-key") ||
            rawPayload.getThreadId() ||
            undefined;
          return m365ConversationKey(parsed, rawConversationKey);
        },
      },
      attachments: {
        extractAttachments: ({ parsed, attempt }) => {
          if (attempt !== 0) return [];
          const payload = CodexRawPayload.from(parsed._rawBody || parsed);
          return CodexPayloadNormalizer.normalize(payload).images ?? [];
        },
      },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "m365-copilot",
        executeTurn: async ({
          prompt,
          attempt,
          parsed,
          incoming,
          conversationKey,
          isNewConversation,
          attachments,
        }) => {
          const rawResponse = await executeM365Turn(prompt, {
            // Quarantine: browser vẫn thu thập stream nhưng adapter không emit trước validation.
            onChunk: () => {},
            signal: incoming.abortSignal,
            traceId: incoming.headers.get("x-codex-trace-id") || undefined,
            conversationKey,
            isNewConversation: attempt === 0 ? isNewConversation : false,
            modelSlug: parsed.modelId,
            reasoning: parsed.options.reasoning,
            images: attachments,
          });
          return { rawResponse };
        },
      },
      response: {
        classifyValidationFailure: (failure: ToolValidationFailure) => {
          if (failure.message.includes("vi phạm quy tắc an toàn")) {
            return "DISALLOWED_COMMAND";
          }
          return failure.code === "UNKNOWN_TOOL"
            ? "UNKNOWN_TOOL"
            : "INVALID_TOOL_CALL";
        },
        createCallId: () => `call_${Math.random().toString(36).slice(2, 10)}`,
        includeDetailedDoneEvent: true,
        toolCallStopReason: "tool_use",
        toolCallEndTurn: false,
        computeUsage: ({ totalPromptChars, lastRaw }) => {
          const inputTokens = Math.ceil(totalPromptChars / 4);
          const outputTokens = Math.ceil((lastRaw.length || 10) / 4);
          return {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          };
        },
      },
    });
  }
}

/**
 * Factory khởi tạo đối tượng M365CopilotAdapter với đầy đủ các cấu hình và dependencies cần thiết.
 */
export function createM365CopilotAdapter(): ProviderAdapter {
  return new M365CopilotAdapter();
}
