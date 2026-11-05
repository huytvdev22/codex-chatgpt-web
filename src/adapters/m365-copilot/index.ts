import type { ProviderAdapter } from "../base";
import { promptCompiler } from "../web/prompt/index";
import { CodexRawPayload, CodexPayloadNormalizer } from "../web/normalization";
import { M365BrowserWorker, m365ConversationKey } from "./browser";
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
  private readonly worker: M365BrowserWorker;

  constructor() {
    const worker = new M365BrowserWorker();
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
        launcherFailureMode: "fail-closed",
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
        resolveState: ({
          leaseConversationId,
          launcherReused,
          hasPriorAssistantReply,
        }) => ({
          existingConversationId: leaseConversationId,
          isNewConversation:
            !launcherReused &&
            !hasPriorAssistantReply &&
            !leaseConversationId,
        }),
        onConversationUpdated: ({ conversationId }) => conversationId,
        resolveEndTurnBinding: ({ finalStatus, activeConversationId }) => ({
          connectorBound:
            finalStatus === "completed" && Boolean(activeConversationId),
          conversationId: activeConversationId,
        }),
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
        resolveSurfaceId: (descriptor, leaseSurfaceId) =>
          leaseSurfaceId || descriptor.m365SurfaceId || descriptor.surfaceId,
        executeTurn: async ({
          page,
          prompt,
          attempt,
          parsed,
          incoming,
          conversationKey,
          existingConversationId,
          launcherReused,
          isNewConversation,
          attachments,
          heartbeat,
        }) => {
          if (!page) {
            throw new Error(
              "[m365-adapter] Không có trình duyệt khả dụng để thực thi lượt.",
            );
          }
          return worker.executeTurn(prompt, {
            page,
            // Quarantine: browser vẫn thu thập stream nhưng adapter không emit trước validation.
            onChunk: () => {},
            signal: incoming.abortSignal,
            conversationKey,
            existingConversationId,
            launcherReused,
            isNewConversation: attempt === 0 ? isNewConversation : false,
            heartbeat,
            modelSlug: parsed.modelId,
            reasoning: parsed.options.reasoning,
            images: attachments,
          });
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
    this.worker = worker;
  }
}

/**
 * Factory khởi tạo đối tượng M365CopilotAdapter với đầy đủ các cấu hình và dependencies cần thiết.
 */
export function createM365CopilotAdapter(): ProviderAdapter {
  return new M365CopilotAdapter();
}
