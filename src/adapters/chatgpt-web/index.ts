import type { ProviderAdapter, IncomingMeta } from "../base";
import { hasActualPriorAssistantReply } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { ChatGptBrowserWorker, isValidChatGptConversationId } from "./chatgpt-browser-worker";
import { CHATGPT_SELECTORS } from "./selectors";
import { defaultChatGptConversationStore, chatGptConversationKey } from "./conversation-store";
import { resolveWebThreadId } from "../web/turn-identity";
import { compileWebPrompt } from "../web/compile-prompt";
import {
  parseStrictM365Response,
} from "../web/protocol/strict-response-parser";
import { validateWebProtocolResponse } from "../web/protocol/validate-response";
import { runWebProtocolRetry } from "../web/protocol/retry-response";
import { emitWebProtocolResponse } from "../web/protocol/emit-response";
import {
  closeLauncherBrowserTurn,
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

export interface ChatGptAdapterOptions {
  userDataDir?: string;
  headless?: boolean;
  descriptorPath?: string;
  maxFormatRetries?: number;
}

export class ChatGptWebAdapter implements ProviderAdapter {
  readonly name = "chatgpt-web";
  private options: ChatGptAdapterOptions;
  private localBrowser: LocalBrowserRuntime;
  private worker: ChatGptBrowserWorker;

  constructor(options?: ChatGptAdapterOptions) {
    this.options = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-chatgpt-web"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    this.localBrowser = new LocalBrowserRuntime({
      profileDir: this.options.userDataDir!,
      headless: this.options.headless,
      logPrefix: "chatgpt-adapter",
    });
    this.worker = new ChatGptBrowserWorker();
  }

  /**
   * Compatibility wrapper retained for existing adapter contract tests and
   * callers that inspect ChatGPT prompt compilation directly.
   */
  private compilePrompt(parsed: CodexParsedRequest, isNewConversation: boolean): string {
    return compileWebPrompt(parsed, {
      assistantName: "ChatGPT",
      isNewConversation,
    }).finalPrompt;
  }

  /**
   * Điều phối một lượt tương tác giữa Codex và ChatGPT Web
   */
  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    if (incoming.abortSignal?.aborted) {
      throw new DOMException("ChatGpt turn aborted before start", "AbortError");
    }

    // 1. Trích xuất threadId theo thứ tự ưu tiên dùng chung của Web adapters
    const threadId = resolveWebThreadId(
      parsed._rawBody,
      parsed,
      incoming.headers,
    );

    const conversationKey = chatGptConversationKey(parsed, threadId);
    const turnTraceId = incoming.headers.get("x-codex-trace-id") || randomBytes(12).toString("base64url");

    const descriptorPath = resolveLauncherDescriptorPath(this.options.descriptorPath);
    let launcherConnection: LauncherBrowserConnection | null = null;
    let page: Page | null = null;
    let surfaceId: string | undefined;
    let leaseConversationId: string | undefined;
    let finalStatus: "completed" | "failed" | "aborted" = "failed";
    let activeConversationId: string | undefined;

    // 2. Kết nối Launcher Surface qua notifyLauncherTurn (chuẩn M365/Launcher lifecycle)
    if (descriptorPath) {
      try {
        console.log(`[chatgpt-adapter] Đăng ký turn với Launcher (phase=start, conversationKey=${conversationKey || 'none'})...`);
        const session = await startLauncherBrowserTurn({
          descriptorPath,
          activity: {
            phase: "start",
            traceId: turnTraceId,
            helperPid: process.pid,
            conversationKey,
            connectorIdentity: "chatgpt-web",
            provider: "chatgpt",
            requireRetainedConversation: false,
          },
          signal: incoming.abortSignal,
          resolveSurfaceId: (descriptor, leaseSurfaceId) =>
            leaseSurfaceId || descriptor.chatGptSurfaceId || descriptor.surfaceId,
        });
        if (session) {
          surfaceId = session.surfaceId;
          leaseConversationId = session.conversationId;
          launcherConnection = session.connection;
          page = session.connection.page;
          console.log(`[chatgpt-adapter] Launcher cấp surface: ${surfaceId} (reused=${session.reused}, convId=${session.conversationId || 'mới'})`);
        }
      } catch (err) {
        console.warn(`[chatgpt-adapter] Không thể kết nối Launcher qua CDP: ${err instanceof Error ? err.message : String(err)}. Sẽ thử local Chrome.`);
      }
    }

    if (!page) {
      if (descriptorPath) {
        throw new Error("[chatgpt-adapter] Không thể kết nối với Launcher browser tab.");
      }
      page = await this.localBrowser.ensurePage();
    }

    // 3. Xác định trạng thái hội thoại và kịch bản prompt
    const storedConvId = defaultChatGptConversationStore.getConversationId(threadId);
    const rawExistingConvId = leaseConversationId || storedConvId;
    const existingConversationId = isValidChatGptConversationId(rawExistingConvId) ? rawExistingConvId : undefined;

    const hasPriorAssistantReply = hasActualPriorAssistantReply(parsed.context.messages);
    // Chỉ là phiên mới nếu thực sự chưa có phản hồi trợ lý VÀ thread này chưa có cuộc trò chuyện nào được lưu
    const isNewConversation = !hasPriorAssistantReply && !existingConversationId;
    activeConversationId = existingConversationId;

    const initialPrompt = this.compilePrompt(parsed, isNewConversation);

    const reasoningEffort = parsed.options.reasoning || "low";
    console.log(`[chatgpt-adapter] Bắt đầu lượt gửi (thread=${threadId || "n/a"}, conv=${existingConversationId || "mới"}, isNew=${isNewConversation}, think=${reasoningEffort})`);

    try {
      const maxRetries = this.options.maxFormatRetries ?? 2;
      const protocolResult = await runWebProtocolRetry({
        initialPrompt,
        maxRetries,
        providerName: "ChatGPT",
        abortSignal: incoming.abortSignal,
        execute: async ({ attempt, prompt }) => {
          console.log(`[chatgpt-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`);

          const result = await this.worker.executeTurn(page, {
            prompt,
            signal: incoming.abortSignal,
            reasoningEffort,
            conversationId: existingConversationId,
            isNewConversation,
            onChunk: () => {},
          });

          if (isValidChatGptConversationId(result.conversationId)) {
            activeConversationId = result.conversationId;
            defaultChatGptConversationStore.setConversationId(threadId, result.conversationId);
            console.log(`[chatgpt-adapter] Đã ghi nhận conversationId: "${result.conversationId}" (threadId="${threadId || 'active'}")`);
          }

          const lastRaw = result.rawResponse;
          console.log(`[chatgpt-adapter] Đã nhận rawResponse (${lastRaw.length} ký tự). Đang phân tích strict response...`);
          return validateWebProtocolResponse(
            parseStrictM365Response(lastRaw),
            parsed.context.tools || [],
          );
        },
        onProtocolError: result => {
          console.warn(`[chatgpt-adapter] [Format Error] Lỗi giao thức (${result.code}): ${result.message}`);
        },
      });

      finalStatus = "completed";

      if (protocolResult.kind === "final_answer") {
        console.log(`[chatgpt-adapter] Trả về final answer (${protocolResult.content.length} ký tự).`);
      } else {
        console.log(`[chatgpt-adapter] Phát hiện ${protocolResult.calls.length} tool calls hợp lệ.`);
      }

      emitWebProtocolResponse({
        result: protocolResult,
        clientTools: parsed.context.tools || [],
        emit,
        createCallId: () =>
          `call_chatgpt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      });

      console.log(`[chatgpt-adapter] Kết thúc lượt thành công.`);
    } catch (error) {
      finalStatus = incoming.abortSignal?.aborted ? "aborted" : "failed";
      console.error("[chatgpt-adapter] Lỗi trong quá trình thực thi lượt:", error);
      emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      // 5. Giải phóng lượt và YÊU CẦU LAUNCHER GIỮ LẠI (RETAIN) TAB HỘI THOẠI
      if (descriptorPath) {
        const isConvValid = isValidChatGptConversationId(activeConversationId);
        console.log(`[chatgpt-adapter] Báo cáo Launcher kết thúc lượt (phase=end, status=${finalStatus}, retain=true, convId=${isConvValid ? activeConversationId : 'none'})...`);
        await endLauncherBrowserTurn({
          descriptorPath,
          activity: {
            phase: "end",
            traceId: turnTraceId,
            helperPid: process.pid,
            provider: "chatgpt",
            status: finalStatus,
            retain: true,
            connectorBound: finalStatus === "completed" && isConvValid,
            ...(isConvValid ? { conversationId: activeConversationId } : {}),
          },
          onError: releaseErr => {
            console.warn("[chatgpt-adapter] Không thể gửi phase=end tới launcher:", releaseErr);
          },
        });
      }

      await closeLauncherBrowserTurn(launcherConnection);
    }
  }

  async close(): Promise<void> {
    await this.localBrowser.close();
  }
}

export function createChatGptWebAdapter(options?: ChatGptAdapterOptions): ChatGptWebAdapter {
  return new ChatGptWebAdapter(options);
}

export * from "./selectors";
export * from "./capability-picker";
export * from "./chatgpt-browser-worker";
export * from "./conversation-store";
export * from "./markdown";
