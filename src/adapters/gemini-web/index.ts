import type { ProviderAdapter, IncomingMeta } from "../base";
import { hasActualPriorAssistantReply } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { geminiBrowserWorker, GeminiBrowserWorker } from "./gemini-browser-worker";
import { GEMINI_SELECTORS, type GeminiDomSelectors } from "./selectors";
import {
  buildUnifiedToolProtocol,
  buildShortOutputFormatAnchor,
  TOOL_REMINDER_PROMPT,
} from "../web/prompt";
import { compileWebPrompt } from "../web/compile-prompt";
import { resolveGeminiReasoningEffort } from "../../models/model-registry";
import {
  parseStrictM365Response,
} from "../web/protocol/strict-response-parser";
import { validateWebProtocolResponse } from "../web/protocol/validate-response";
import { runWebProtocolRetry } from "../web/protocol/retry-response";
import { emitWebProtocolResponse } from "../web/protocol/emit-response";
import {
  CodexRawPayload,
} from "../web/normalization";
import {
  closeLauncherBrowserTurn,
  resolveLauncherDescriptorPath,
  startLauncherBrowserTurn,
} from "../web/launcher-runtime";
import { LocalBrowserRuntime } from "../web/local-browser-runtime";
import type { Page } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  notifyLauncherTurn,
  type LauncherBrowserConnection,
} from "../../launcher-browser-host";
import { extractCodexTurnIdentityFromBody } from "../web/turn-identity";

export interface GeminiAdapterOptions {
  userDataDir?: string;
  customSelectors?: Partial<GeminiDomSelectors>;
  headless?: boolean;
  descriptorPath?: string;
  maxFormatRetries?: number;
}

export class GeminiWebAdapter implements ProviderAdapter {
  readonly name = "gemini-web";
  private options: GeminiAdapterOptions;
  private localBrowser: LocalBrowserRuntime;

  constructor(options?: GeminiAdapterOptions) {
    this.options = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-gemini-web"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    this.localBrowser = new LocalBrowserRuntime({
      profileDir: this.options.userDataDir!,
      headless: this.options.headless,
      logPrefix: "gemini-adapter",
    });
  }

  /**
   * Điều phối một lượt tương tác (turn) giữa Codex và Gemini Web
   */
  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    if (incoming.abortSignal?.aborted) {
      throw new DOMException("Gemini turn aborted before start", "AbortError");
    }

    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const threadId =
      rawPayload.getThreadId() ||
      incoming.headers.get("x-codex-conversation-key") ||
      extractCodexTurnIdentityFromBody(parsed._rawBody || parsed).threadId;
    const conversationKey = createHash("sha256")
      .update(`gemini-web:${threadId || "default-session"}`, "utf8")
      .digest("hex");
    const turnTraceId = incoming.headers.get("x-codex-trace-id") || randomBytes(12).toString("base64url");

    const descriptorPath = resolveLauncherDescriptorPath(this.options.descriptorPath);
    let launcherConnection: LauncherBrowserConnection | null = null;
    let page: Page | null = null;
    let leaseStarted = false;
    let finalStatus: "completed" | "failed" | "aborted" = "failed";

    if (descriptorPath) {
      let launcherError: Error | null = null;
      try {
        const session = await startLauncherBrowserTurn({
          descriptorPath,
          activity: {
            phase: "start",
            traceId: turnTraceId,
            helperPid: process.pid,
            conversationKey,
            connectorIdentity: "gemini-web",
            provider: "gemini",
            requireRetainedConversation: false,
          },
          signal: incoming.abortSignal,
          resolveSurfaceId: (descriptor, leaseSurfaceId) =>
            leaseSurfaceId || descriptor.geminiSurfaceId || descriptor.surfaceId,
        });
        if (session) {
          leaseStarted = true;
          launcherConnection = session.connection;
          page = session.connection.page;
          console.log(`[gemini-adapter] Kết nối Playwright qua Launcher CDP (pid=${session.connection.descriptor.pid}, surface=${session.surfaceId})...`);
        }
      } catch (err) {
        launcherError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[gemini-adapter] Không thể kết nối Launcher qua CDP: ${launcherError.message}. Sẽ thử local Chrome.`);
      }
    }

    if (!page) {
      page = await this.localBrowser.ensurePage();
    }

    const hasPriorAssistantReply = hasActualPriorAssistantReply(parsed.context.messages);
    const isNewConversation = !hasPriorAssistantReply;
    const initialPrompt = compileWebPrompt(parsed, {
      assistantName: "Gemini",
      isNewConversation,
    }).finalPrompt;
    const reasoningEffort = resolveGeminiReasoningEffort(parsed.modelId, parsed.options.reasoning);

    console.log(`[gemini-adapter] Bắt đầu lượt gửi cho model: ${parsed.modelId}, cấp độ tư duy: ${reasoningEffort || "mặc định"}`);

    try {
      const maxRetries = this.options.maxFormatRetries ?? 2;
      const protocolResult = await runWebProtocolRetry({
        initialPrompt,
        maxRetries,
        providerName: "Gemini",
        abortSignal: incoming.abortSignal,
        execute: async ({ attempt, prompt }) => {
          console.log(`[gemini-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`);

          const result = await geminiBrowserWorker.executeTurn(page, {
            prompt,
            signal: incoming.abortSignal,
            modelSlug: parsed.modelId,
            reasoningEffort,
            customSelectors: this.options.customSelectors,
            // Quarantine: không emit chunk trực tiếp ra Codex trong lúc stream để tránh leak protocol XML
            onChunk: () => {},
          });

          const lastRaw = result.rawResponse;
          console.log(`[gemini-adapter] Đã nhận rawResponse (${lastRaw.length} ký tự). Áp dụng strict-parser...`);
          return validateWebProtocolResponse(
            parseStrictM365Response(lastRaw),
            parsed.context.tools || [],
          );
        },
        onProtocolError: result => {
          console.warn(`[gemini-adapter] [Format Error] Lỗi giao thức (${result.code}): ${result.message}`);
        },
      });

      if (protocolResult.kind === "final_answer") {
        console.log(`[gemini-adapter] Trả về final answer (${protocolResult.content.length} ký tự).`);
      } else {
        console.log(`[gemini-adapter] Phát hiện ${protocolResult.calls.length} tool calls hợp lệ.`);
      }

      emitWebProtocolResponse({
        result: protocolResult,
        clientTools: parsed.context.tools || [],
        emit,
        createCallId: () =>
          `call_gemini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      });

      finalStatus = "completed";
      console.log(`[gemini-adapter] Kết thúc lượt thành công.`);
    } catch (error) {
      finalStatus = incoming.abortSignal?.aborted ? "aborted" : "failed";
      console.error("[gemini-adapter] Lỗi trong quá trình thực thi lượt:", error);
      emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (descriptorPath && leaseStarted) {
        try {
          await notifyLauncherTurn(descriptorPath, {
            phase: "end",
            traceId: turnTraceId,
            helperPid: process.pid,
            provider: "gemini",
            status: finalStatus,
            retain: true,
            connectorBound: finalStatus === "completed",
          });
        } catch (releaseErr) {
          console.warn("[gemini-adapter] Không thể gửi phase=end tới launcher:", releaseErr);
        }
      }
      await closeLauncherBrowserTurn(launcherConnection);
    }
  }

  async close(): Promise<void> {
    await this.localBrowser.close();
  }
}

export function createGeminiWebAdapter(options?: GeminiAdapterOptions): GeminiWebAdapter {
  return new GeminiWebAdapter(options);
}

export * from "./selectors";
export * from "./gemini-browser-worker";
