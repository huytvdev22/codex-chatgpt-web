import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ProviderAdapter } from "../base";
import { GoogleAIStudioBrowserWorker } from "./browser-worker";
import {
  defaultGoogleAIStudioConversationStore,
  googleAIStudioConversationKey,
} from "./conversation-store";
import { type ToolValidationFailure } from "../web/tools";
import { LocalBrowserRuntime } from "../web/local-browser-runtime";
import { WebProviderAdapter } from "../web/web-provider-adapter";

export interface GoogleAIStudioAdapterOptions {
  userDataDir?: string;
  headless?: boolean;
  descriptorPath?: string;
  maxFormatRetries?: number;
}

/**
 * Làm sạch chuỗi raw response từ Google AI Studio:
 * 1. Cắt bỏ bất kỳ ký tự rác nào dẫn trước <webResponse> (ví dụ: button text, icons 'code Codedownloadcontent_copyexpand_lessless').
 * 2. Cắt bỏ bất kỳ ký tự rác nào kéo theo sau </webResponse>.
 * 3. Nếu không có <webResponse>, dọn sạch khoảng trắng thừa.
 */
export function sanitizeAIStudioResponse(raw: string): string {
  if (typeof raw !== "string") return "";
  let cleaned = raw.trim();

  // 1. Cắt bỏ tiền tố rác trước <webResponse>
  const rootOpenIdx = cleaned.indexOf("<webResponse>");
  if (rootOpenIdx > 0) {
    cleaned = cleaned.slice(rootOpenIdx).trim();
  }

  // 2. Cắt bỏ hậu tố rác sau </webResponse>
  const rootCloseIdx = cleaned.lastIndexOf("</webResponse>");
  if (rootCloseIdx !== -1) {
    const endPos = rootCloseIdx + "</webResponse>".length;
    if (endPos < cleaned.length) {
      cleaned = cleaned.slice(0, endPos).trim();
    }
  }

  return cleaned;
}

export class GoogleAIStudioAdapter extends WebProviderAdapter {
  override readonly name = "google-ai-studio";
  private options: GoogleAIStudioAdapterOptions;
  private worker: GoogleAIStudioBrowserWorker;

  constructor(options?: GoogleAIStudioAdapterOptions) {
    const resolvedOptions: GoogleAIStudioAdapterOptions = {
      userDataDir:
        options?.userDataDir || join(homedir(), ".codex-google-ai-studio"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    const localBrowser = new LocalBrowserRuntime({
      profileDir: resolvedOptions.userDataDir!,
      headless: resolvedOptions.headless,
      logPrefix: "ai-studio-adapter",
    });
    const worker = new GoogleAIStudioBrowserWorker();

    super(
      {
        id: "google-ai-studio",
        assistantName: "Google AI Studio",
        logPrefix: "ai-studio-adapter",
        abortMessage: "Google AI Studio turn aborted before start",
        policies: {
          launcherFailureMode: "fail-closed",
          closeLauncherConnectionOnEnd: false,
          emitErrorEventOnFailure: false,
          rethrowError: true,
          maxFormatRetries: resolvedOptions.maxFormatRetries ?? 2,
          traceIdOptions: {
            byteLength: 16,
            encoding: "hex",
          },
        },
        conversation: {
          resolveConversationKey: ({ parsed, incoming, threadId }) => {
            const rawConversationKey =
              incoming.headers.get("x-codex-conversation-key") ||
              threadId ||
              undefined;
            return googleAIStudioConversationKey(parsed, rawConversationKey);
          },
          resolveState: ({
            conversationKey,
            leaseConversationId,
            launcherReused,
            hasPriorAssistantReply,
          }) => {
            const storedPromptId = conversationKey
              ? defaultGoogleAIStudioConversationStore.get(conversationKey)
              : undefined;
            const existingConversationId =
              leaseConversationId || storedPromptId;
            const isNewConversation =
              !launcherReused &&
              !hasPriorAssistantReply &&
              !existingConversationId;
            return { existingConversationId, isNewConversation };
          },
          onConversationUpdated: ({ conversationKey, conversationId }) => {
            if (conversationId) {
              if (conversationKey) {
                defaultGoogleAIStudioConversationStore.set(
                  conversationKey,
                  conversationId,
                );
                console.log(
                  `[ai-studio-adapter] Đã ghi nhận promptId mới: "${conversationId}"`,
                );
              }
              return conversationId;
            }
            return undefined;
          },
          resolveEndTurnBinding: ({ activeConversationId, conversationKey }) => ({
            connectorBound: true,
            conversationId: activeConversationId || conversationKey,
          }),
        },
        capability: {
          resolveReasoningEffort: parsed =>
            parsed.options.reasoning || "medium",
        },
        browser: {
          descriptorPath: resolvedOptions.descriptorPath,
          descriptorSubdirs: [".codex-google-ai-studio"],
          launcherProviderId: "google-ai-studio",
          connectorIdentity: "google-ai-studio",
          executeTurn: async ({
            page,
            prompt,
            attempt,
            incoming,
            reasoningEffort,
            existingConversationId,
            isNewConversation,
          }) => {
            if (!page) {
              throw new Error(
                "[ai-studio-adapter] Không có trình duyệt khả dụng để thực thi lượt.",
              );
            }
            const maxRetries = resolvedOptions.maxFormatRetries ?? 2;
            console.log(
              `[ai-studio-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`,
            );
            const result = await worker.executeTurn(page, {
              prompt,
              signal: incoming.abortSignal,
              reasoningEffort: (reasoningEffort || "medium") as
                | "low"
                | "medium"
                | "high",
              promptId: existingConversationId,
              isNewConversation: attempt === 0 ? isNewConversation : false,
              onChunk: () => {
                // Quarantine: Browser vẫn thu thập stream, nhưng adapter TUYỆT ĐỐI không emit thô trước validation
              },
            });
            return {
              rawResponse: result.rawResponse,
              conversationId: result.promptId,
            };
          },
        },
        response: {
          sanitizeRawResponse: sanitizeAIStudioResponse,
          tolerantNaturalTextFallback: true,
          classifyValidationFailure: (failure: ToolValidationFailure) => {
            if (failure.message.includes("vi phạm quy tắc an toàn")) {
              return "DISALLOWED_COMMAND";
            }
            return failure.code === "UNKNOWN_TOOL"
              ? "UNKNOWN_TOOL"
              : "INVALID_TOOL_CALL";
          },
          createCallId: () => `call_${randomBytes(8).toString("hex")}`,
          includeDetailedDoneEvent: true,
          computeUsage: ({ initialPrompt, lastRaw }) => {
            const inputTokens = Math.ceil(initialPrompt.length / 4);
            const outputTokens = Math.ceil((lastRaw.length || 10) / 4);
            return {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            };
          },
        },
      },
      localBrowser,
    );

    this.options = resolvedOptions;
    this.worker = worker;
  }
}

export function createGoogleAIStudioAdapter(
  options?: GoogleAIStudioAdapterOptions,
): ProviderAdapter {
  return new GoogleAIStudioAdapter(options);
}
