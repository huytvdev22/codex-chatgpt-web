import type { ProviderAdapter, IncomingMeta } from "../base";
import { hasActualPriorAssistantReply } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { QwenBrowserWorker } from "./qwen-browser-worker";
import { isValidQwenConversationId, QWEN_SELECTORS } from "./selectors";
import { defaultQwenConversationStore, qwenConversationKey } from "./conversation-store";
import {
  resolveWebThreadId,
  resolveWebTurnTraceId,
} from "../web/turn-identity";
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
import {
  type LauncherBrowserConnection,
} from "../../launcher-browser-host";

export interface QwenAdapterOptions {
  userDataDir?: string;
  headless?: boolean;
  descriptorPath?: string;
  maxFormatRetries?: number;
}

export class QwenWebAdapter implements ProviderAdapter {
  readonly name = "qwen-web";
  private options: QwenAdapterOptions;
  private localBrowser: LocalBrowserRuntime;
  private worker: QwenBrowserWorker;

  constructor(options?: QwenAdapterOptions) {
    this.options = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-qwen-web"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    this.localBrowser = new LocalBrowserRuntime({
      profileDir: this.options.userDataDir!,
      headless: this.options.headless,
      logPrefix: "qwen-adapter",
    });
    this.worker = new QwenBrowserWorker();
  }

  /**
   * Điều phối một lượt tương tác giữa Codex và Qwen Web
   */
  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    if (incoming.abortSignal?.aborted) {
      throw new DOMException("Qwen turn aborted before start", "AbortError");
    }

    // 1. Trích xuất threadId theo thứ tự ưu tiên dùng chung của Web adapters
    const threadId = resolveWebThreadId(
      parsed._rawBody,
      parsed,
      incoming.headers,
    );

    const conversationKey = qwenConversationKey(parsed, threadId);
    const turnTraceId = resolveWebTurnTraceId({
      headers: incoming.headers,
    });

    const descriptorPath = resolveLauncherDescriptorPath(this.options.descriptorPath);
    let launcherConnection: LauncherBrowserConnection | null = null;
    let page: Page | null = null;
    let surfaceId: string | undefined;
    let leaseConversationId: string | undefined;
    let finalStatus: "completed" | "failed" | "aborted" = "failed";
    let activeConversationId: string | undefined;

    let launcherError: Error | null = null;

    // 2. Kết nối Launcher Surface nếu có
    if (descriptorPath) {
      try {
        console.log(`[qwen-adapter] Đăng ký turn với Launcher (phase=start, conversationKey=${conversationKey || 'none'})...`);
        const session = await startLauncherBrowserTurn({
          descriptorPath,
          activity: {
            phase: "start",
            traceId: turnTraceId,
            helperPid: process.pid,
            conversationKey,
            connectorIdentity: "qwen-web",
            provider: "qwen",
            requireRetainedConversation: false,
          },
          signal: incoming.abortSignal,
          resolveSurfaceId: (descriptor, leaseSurfaceId) =>
            leaseSurfaceId || descriptor.qwenSurfaceId || descriptor.surfaceId,
        });
        if (session) {
          surfaceId = session.surfaceId;
          leaseConversationId = session.conversationId;
          launcherConnection = session.connection;
          page = session.connection.page;
          console.log(`[qwen-adapter] Launcher cấp surface: ${surfaceId} (reused=${session.reused}, convId=${session.conversationId || 'mới'})`);
        }
      } catch (err) {
        launcherError = err instanceof Error ? err : new Error(String(err));
        console.error(`[qwen-adapter] Không thể kết nối Launcher qua CDP:`, err);
      }
    }

    if (!page) {
      if (descriptorPath) {
        throw new Error(`[qwen-adapter] Không thể kết nối với Launcher browser tab: ${launcherError?.message || "không tìm thấy tab"}`);
      }
      page = await this.localBrowser.ensurePage();
    }

    // 3. Xác định trạng thái hội thoại và kịch bản prompt
    const storedConvId = defaultQwenConversationStore.getConversationId(threadId);
    const rawExistingConvId = leaseConversationId || storedConvId;
    const existingConversationId = isValidQwenConversationId(rawExistingConvId || "") ? rawExistingConvId : undefined;

    const hasPriorAssistantReply = hasActualPriorAssistantReply(parsed.context.messages);
    // Chỉ là phiên mới nếu thực sự chưa có phản hồi trợ lý VÀ thread này chưa có cuộc trò chuyện nào được lưu
    const isNewConversation = !hasPriorAssistantReply && !existingConversationId;
    activeConversationId = existingConversationId;

    const initialPrompt = compileWebPrompt(parsed, {
      assistantName: "Qwen",
      isNewConversation,
    }).finalPrompt;

    const reasoningEffort = parsed.options.reasoning || "low";
    console.log(`[qwen-adapter] Bắt đầu lượt gửi (thread=${threadId || "n/a"}, conv=${existingConversationId || "mới"}, isNew=${isNewConversation})`);

    try {
      const maxRetries = this.options.maxFormatRetries ?? 2;
      const protocolResult = await runWebProtocolRetry({
        initialPrompt,
        maxRetries,
        providerName: "Qwen",
        abortSignal: incoming.abortSignal,
        execute: async ({ attempt, prompt }) => {
          console.log(`[qwen-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`);

          const result = await this.worker.executeTurn(page, {
            prompt,
            signal: incoming.abortSignal,
            reasoningEffort,
            conversationId: existingConversationId,
            isNewConversation,
            onChunk: () => {},
          });

          if (isValidQwenConversationId(result.conversationId || "")) {
            activeConversationId = result.conversationId;
            defaultQwenConversationStore.setConversationId(threadId, result.conversationId!);
            console.log(`[qwen-adapter] Đã ghi nhận conversationId: "${result.conversationId}" (threadId="${threadId || 'active'}")`);
          }

          const lastRaw = result.rawResponse;
          console.log(`[qwen-adapter] Đã nhận rawResponse (${lastRaw.length} ký tự). Đang phân tích strict response...`);
          return validateWebProtocolResponse(
            parseStrictM365Response(lastRaw),
            parsed.context.tools || [],
          );
        },
        onProtocolError: result => {
          console.warn(`[qwen-adapter] [Format Error] Lỗi giao thức (${result.code}): ${result.message}`);
        },
      });

      finalStatus = "completed";

      if (protocolResult.kind === "final_answer") {
        console.log(`[qwen-adapter] Trả về final answer (${protocolResult.content.length} ký tự).`);
      } else {
        console.log(`[qwen-adapter] Phát hiện ${protocolResult.calls.length} tool calls hợp lệ.`);
      }

      emitWebProtocolResponse({
        result: protocolResult,
        clientTools: parsed.context.tools || [],
        emit,
        createCallId: () =>
          `call_qwen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      });

      console.log(`[qwen-adapter] Kết thúc lượt thành công.`);
    } catch (error) {
      finalStatus = incoming.abortSignal?.aborted ? "aborted" : "failed";
      throw error;
    } finally {
      // 5. Thông báo kết thúc turn với Launcher
      if (descriptorPath && launcherConnection) {
        const isConvValid = isValidQwenConversationId(activeConversationId || "");
        console.log(`[qwen-adapter] Báo cáo Launcher kết thúc lượt (phase=end, status=${finalStatus}, retain=true, convId=${isConvValid ? activeConversationId : 'none'})...`);
        await endLauncherBrowserTurn({
          descriptorPath,
          activity: {
            phase: "end",
            traceId: turnTraceId,
            helperPid: process.pid,
            provider: "qwen",
            status: finalStatus,
            retain: true,
            connectorBound: finalStatus === "completed" && isConvValid,
            ...(isConvValid ? { conversationId: activeConversationId } : {}),
          },
          onError: releaseErr => {
            console.warn("[qwen-adapter] Không thể gửi phase=end tới launcher:", releaseErr);
          },
        });
      }

      await closeLauncherBrowserTurn(launcherConnection);
    }
  }

  async abortTurn(): Promise<void> {
    const activePage = this.localBrowser.getActivePage();
    if (activePage) {
      await activePage.locator(QWEN_SELECTORS.stopButton).first().click().catch(() => {});
    }
  }

  async cleanup(): Promise<void> {
    await this.localBrowser.closeSafely();
  }
}

export function createQwenWebAdapter(options?: QwenAdapterOptions): ProviderAdapter {
  return new QwenWebAdapter(options);
}
