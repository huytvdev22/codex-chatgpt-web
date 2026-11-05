import type { ProviderAdapter, IncomingMeta } from "../base";
import { hasActualPriorAssistantReply } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { GoogleAIStudioBrowserWorker } from "./browser-worker";
import { parseGoogleAIStudioPromptId, AI_STUDIO_SELECTORS } from "./selectors";
import {
  defaultGoogleAIStudioConversationStore,
  googleAIStudioConversationKey,
} from "./conversation-store";
import { extractCodexTurnIdentityFromBody } from "../web/turn-identity";
import { compileWebPrompt } from "../web/compile-prompt";
import {
  parseStrictM365Response,
  type StrictM365ResponseResult,
} from "../web/protocol/strict-response-parser";
import { validateWebProtocolResponse } from "../web/protocol/validate-response";
import { runWebProtocolRetry } from "../web/protocol/retry-response";
import {
  type ToolValidationFailure,
} from "../web/tools";
import { emitWebProtocolResponse } from "../web/protocol/emit-response";
import {
  CodexRawPayload,
} from "../web/normalization";
import {
  endLauncherBrowserTurn,
  resolveLauncherDescriptorPath,
  startLauncherBrowserTurn,
} from "../web/launcher-runtime";
import { LocalBrowserRuntime } from "../web/local-browser-runtime";
import type { Page } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  type LauncherBrowserConnection,
} from "../../launcher-browser-host";

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

export class GoogleAIStudioAdapter implements ProviderAdapter {
  readonly name = "google-ai-studio";
  private options: GoogleAIStudioAdapterOptions;
  private localBrowser: LocalBrowserRuntime;
  private worker: GoogleAIStudioBrowserWorker;

  constructor(options?: GoogleAIStudioAdapterOptions) {
    this.options = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-google-ai-studio"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    this.localBrowser = new LocalBrowserRuntime({
      profileDir: this.options.userDataDir!,
      headless: this.options.headless,
      logPrefix: "ai-studio-adapter",
    });
    this.worker = new GoogleAIStudioBrowserWorker();
  }

  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    if (incoming.abortSignal?.aborted) {
      throw new DOMException("Google AI Studio turn aborted before start", "AbortError");
    }

    // 1. Khởi tạo identity và conversation key
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const turnIdentity = extractCodexTurnIdentityFromBody(parsed._rawBody);
    const threadId = turnIdentity?.threadId || rawPayload.getThreadId() || "";
    const rawConversationKey = incoming.headers.get("x-codex-conversation-key")
      || threadId
      || undefined;
    const conversationKey = googleAIStudioConversationKey(parsed, rawConversationKey);

    const descriptorPath = resolveLauncherDescriptorPath(
      this.options.descriptorPath,
      [".codex-google-ai-studio"],
    );
    let page: Page | null = null;
    let launcherConnection: LauncherBrowserConnection | null = null;
    let surfaceId: string | undefined;
    let leasePromptId: string | undefined;
    let launcherConversationReused = false;
    const turnTraceId = randomBytes(16).toString("hex");
    let launcherError: Error | null = null;

    // 2. Kết nối Launcher Surface nếu có
    if (descriptorPath) {
      try {
        console.log(`[ai-studio-adapter] Đăng ký turn với Launcher (conversationKey=${conversationKey || 'none'})...`);
        const session = await startLauncherBrowserTurn({
          descriptorPath,
          activity: {
            phase: "start",
            traceId: turnTraceId,
            helperPid: process.pid,
            conversationKey,
            connectorIdentity: "google-ai-studio",
            provider: "google-ai-studio",
            requireRetainedConversation: false,
          },
          signal: incoming.abortSignal,
        });
        if (session) {
          surfaceId = session.surfaceId;
          leasePromptId = session.conversationId;
          launcherConversationReused = session.reused;
          launcherConnection = session.connection;
          page = session.connection.page;
        }
      } catch (err) {
        launcherError = err instanceof Error ? err : new Error(String(err));
        console.error(`[ai-studio-adapter] Không thể kết nối Launcher qua CDP:`, err);
      }
    }

    if (!page) {
      if (descriptorPath) {
        throw new Error(`[ai-studio-adapter] Không thể kết nối với Launcher browser tab: ${launcherError?.message || "không tìm thấy tab"}`);
      }
      page = await this.localBrowser.ensurePage();
    }

    // 3. Xác định trạng thái hội thoại và kịch bản prompt
    const storedPromptId = conversationKey ? defaultGoogleAIStudioConversationStore.get(conversationKey) : undefined;
    const existingPromptId = leasePromptId || storedPromptId;
    const hasPriorAssistantReply = hasActualPriorAssistantReply(parsed.context.messages);
    const isNewConversation = !launcherConversationReused && !hasPriorAssistantReply && !existingPromptId;

    // Biên dịch prompt qua shared Web Adapter pipeline.
    const compileResult = compileWebPrompt(parsed, {
      assistantName: "Google AI Studio",
      isNewConversation,
    });
    const initialPrompt = compileResult.finalPrompt;
    const reasoningEffort = parsed.options.reasoning || "medium";

    console.log(`[ai-studio-adapter] Bắt đầu lượt gửi (thread=${threadId || "n/a"}, promptId=${existingPromptId || "mới"}, isNew=${isNewConversation})`);

    let finalPromptId = existingPromptId;
    let protocolResult: StrictM365ResponseResult | null = null;
    try {
      const maxRetries = this.options.maxFormatRetries ?? 2;
      let lastRaw = "";

      protocolResult = await runWebProtocolRetry({
        initialPrompt,
        maxRetries,
        providerName: "Google AI Studio",
        abortSignal: incoming.abortSignal,
        execute: async ({ attempt, prompt }) => {
          console.log(`[ai-studio-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`);

          const result = await this.worker.executeTurn(page, {
            prompt,
            signal: incoming.abortSignal,
            reasoningEffort,
            promptId: existingPromptId,
            isNewConversation: attempt === 0 ? isNewConversation : false,
            onChunk: () => {
              // Quarantine: Browser vẫn thu thập stream, nhưng adapter TUYỆT ĐỐI không emit thô trước validation
            },
          });

          if (result.promptId) {
            finalPromptId = result.promptId;
            if (conversationKey) {
              defaultGoogleAIStudioConversationStore.set(conversationKey, result.promptId);
              console.log(`[ai-studio-adapter] Đã ghi nhận promptId mới: "${result.promptId}"`);
            }
          }

          lastRaw = sanitizeAIStudioResponse(result.rawResponse);
          console.log(`[ai-studio-adapter] Đã nhận rawResponse (${lastRaw.length} ký tự). Đang phân tích strict response...`);

          let resultProtocol = parseStrictM365Response(lastRaw);
          if (resultProtocol.kind === "protocol_error") {
            const isWrapperError =
              resultProtocol.code === "MISSING_TRANSPORT_FENCE" ||
              resultProtocol.code === "MISSING_RESPONSE_ENVELOPE";
            const hasActionMarkers =
              lastRaw.includes("<tool_call>") ||
              lastRaw.includes("<custom_tool_call") ||
              lastRaw.includes("*** Begin Patch");

            if (isWrapperError && !hasActionMarkers && lastRaw.trim().length > 0) {
              console.log(`[ai-studio-adapter] Tolerant Answers: Chấp nhận phản hồi văn bản tự nhiên (${lastRaw.length} ký tự) làm final_answer.`);
              resultProtocol = {
                kind: "final_answer",
                content: lastRaw.replace(/<\/?webResponse>/gi, "").trim(),
                rawResponse: lastRaw,
              };
            }
          }

          return validateWebProtocolResponse(
            resultProtocol,
            parsed.context.tools || [],
            {
              classifyFailure: (failure: ToolValidationFailure) => {
                if (failure.message.includes("vi phạm quy tắc an toàn")) {
                  return "DISALLOWED_COMMAND";
                }
                return failure.code === "UNKNOWN_TOOL"
                  ? "UNKNOWN_TOOL"
                  : "INVALID_TOOL_CALL";
              },
            },
          );
        },
        onProtocolError: () => {
          console.warn("[ai-studio-adapter] Không thể trích xuất cấu trúc chuẩn từ phản hồi, kích hoạt Retry Prompt...");
        },
      });

      const inputTokens = Math.ceil(initialPrompt.length / 4);
      const outputTokens = Math.ceil((lastRaw.length || 10) / 4);
      const usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };

      if (protocolResult) {
        emitWebProtocolResponse({
          result: protocolResult,
          clientTools: parsed.context.tools || [],
          emit,
          createCallId: () => `call_${randomBytes(8).toString("hex")}`,
          usage,
          includeDetailedDoneEvent: true,
        });
        return;
      }

      // Fallback nếu không khớp envelope: dọn sạch thẻ <webResponse> nếu có trước khi emit
      const cleanFallback = lastRaw.replace(/<\/?webResponse>/gi, "").trim();
      emit({ type: "text_delta", text: cleanFallback });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage });
    } finally {
      if (descriptorPath && surfaceId) {
        const finalStatus = protocolResult ? "completed" : "failed";
        await endLauncherBrowserTurn({
          descriptorPath,
          activity: {
              phase: "end",
              traceId: turnTraceId,
              helperPid: process.pid,
              status: finalStatus,
              conversationId: finalPromptId || conversationKey,
              provider: "google-ai-studio",
              retain: true,
              connectorBound: true,
            },
          signal: incoming.abortSignal,
        });
      }
    }
  }

  async close(): Promise<void> {
    await this.localBrowser.close();
  }
}

export function createGoogleAIStudioAdapter(options?: GoogleAIStudioAdapterOptions): ProviderAdapter {
  return new GoogleAIStudioAdapter(options);
}
