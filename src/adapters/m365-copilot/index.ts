import { randomUUID } from "node:crypto";
import { hasActualPriorAssistantReply, type ProviderAdapter } from "../base";
import type { CodexParsedRequest } from "../../types";
import { CodexRawPayload, CodexPayloadNormalizer } from "../web/normalization";
import { isStructuredJsonOutputTurn } from "../web/prompt";
import { M365BrowserWorker } from "./m365-browser-worker";
import { m365ConversationKey } from "./conversation-key";
import { type ToolValidationFailure } from "../web/tools";
import { WebProviderAdapter } from "../web/web-provider-adapter";

export * from "../web/execution";
export * from "../web/normalization";
export * from "../web/prompt/index";
export * from "../web/protocol";
export * from "../web/tools";
export {
  m365HtmlToMarkdown,
} from "./m365-dom-observer";
export {
  M365BrowserWorker,
  type M365TurnOptions,
  type M365TurnResult,
} from "./m365-browser-worker";
export {
  M365CapabilityPicker,
  type M365CapabilityMode,
  ensureM365CapabilityMode,
  resolveM365CapabilityMode,
} from "./capability-picker";
export {
  M365ModelProvider,
  type M365ModelRouteDefinition,
} from "./model-provider";
export {
  attachFilesViaPlusMenu,
  m365ImageFilePayloads,
  PLUS_MENU_SELECTORS,
  type M365ImagePayload,
  type AttachFilesOptions,
} from "./attachments";
export { m365ConversationKey } from "./conversation-key";
export {
  buildM365ConversationUrl,
  COPILOT_CONVERSATION_ORIGIN,
  isM365ChatHomeUrl,
  isM365LoginUrl,
  M365_CHAT_URL,
  M365_CONVERSATION_ORIGIN,
  normalizeM365ConversationId,
  parseM365ConversationId,
  resolveM365Origin,
  waitForM365ConversationId,
} from "./conversation-url";

function isEphemeralStructuredTurn(
  parsed?: CodexParsedRequest,
  hasPriorAssistantReply?: boolean,
  hasToolResults?: boolean,
): boolean {
  if (!parsed) return false;
  const priorAssistant =
    hasPriorAssistantReply ??
    hasActualPriorAssistantReply(parsed.context?.messages);
  const trailingTools =
    hasToolResults ??
    parsed.context?.messages?.some(message => message.role === "toolResult") ??
    false;
  return isStructuredJsonOutputTurn(parsed, trailingTools) && !priorAssistant;
}

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
      policies: {
        launcherFailureMode: "fail-closed",
        enableEarlyExitOnFinalAnswer: true,
        enableToolLoopGuard: true,
        emitErrorEventOnFailure: true,
        errorMessagePrefix: "[M365 Copilot]",
        rethrowError: false,
        abortedTurnMessage: "M365 Copilot turn aborted",
        maxFormatRetries: resolveM365MaxFormatRetries,
        maxPromptChars: 95_000,
      },
      conversation: {
        resolveConversationKey: ({ parsed, incoming, turnTraceId }) => {
          if (isEphemeralStructuredTurn(parsed)) {
            return m365ConversationKey(
              parsed,
              `ephemeral:${turnTraceId || randomUUID()}`,
            );
          }
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
        resolveEndTurnBinding: ({
          finalStatus,
          activeConversationId,
          parsed,
          hasPriorAssistantReply,
          hasToolResults,
        }) => {
          if (
            isEphemeralStructuredTurn(
              parsed,
              hasPriorAssistantReply,
              hasToolResults,
            )
          ) {
            return {
              connectorBound: false,
              retain: false,
            };
          }
          return {
            connectorBound:
              finalStatus === "completed" && Boolean(activeConversationId),
            conversationId: activeConversationId,
            retain: true,
          };
        },
      },
      attachments: {
        maxInputImages: 3,
        extractAttachments: ({ parsed, attempt, normalized }) => {
          if (attempt !== 0) return [];
          if (normalized) return normalized.images ?? [];
          const payload = CodexRawPayload.from(parsed._rawBody || parsed);
          return CodexPayloadNormalizer.normalize(payload, { maxImages: 3 }).images ?? [];
        },
      },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "m365-copilot",
        resolveSurfaceId: (descriptor, leaseSurfaceId) =>
          leaseSurfaceId || descriptor.providerSurfaceIds?.m365 || descriptor.surfaceId,
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
          retain,
          attachments,
          heartbeat,
        }) => {
          if (!page) {
            throw new Error(
              "[m365-adapter] Không có trình duyệt khả dụng để thực thi lượt.",
            );
          }
          return worker.executeTurn(page, {
            prompt,
            // Quarantine: browser vẫn thu thập stream nhưng adapter không emit trước validation.
            onChunk: () => {},
            streamIncremental: false,
            signal: incoming.abortSignal,
            conversationKey,
            existingConversationId,
            launcherReused,
            isNewConversation: attempt === 0 ? isNewConversation : false,
            retain,
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
