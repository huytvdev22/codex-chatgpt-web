import type { ProviderAdapter, IncomingMeta } from "../base";
import { hasActualPriorAssistantReply } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { ChatGptBrowserWorker, isValidChatGptConversationId } from "./chatgpt-browser-worker";
import { CHATGPT_SELECTORS } from "./selectors";
import { defaultChatGptConversationStore, chatGptConversationKey } from "./conversation-store";
import { extractCodexTurnIdentityFromBody } from "./environment";
import {
  M365PromptCompiler,
  buildM365FormatRetryPrompt,
} from "../m365-copilot/prompts";
import {
  parseStrictM365Response,
  type StrictM365ResponseResult,
} from "../m365-copilot/translation/strict-response-parser";
import {
  normalizeM365ToolArguments,
  validateM365ToolCall,
  M365ToolBridge,
} from "../m365-copilot/tools";
import {
  CodexRawPayload,
  CodexPayloadNormalizer,
} from "../m365-copilot/normalization";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  connectLauncherBrowserHost,
  readLauncherBrowserHostDescriptor,
  notifyLauncherTurn,
  type LauncherBrowserConnection,
} from "../../launcher-browser-host";
import { getConfigDir } from "../../config";
import { processRunning } from "../../process";

export interface ChatGptAdapterOptions {
  userDataDir?: string;
  headless?: boolean;
  descriptorPath?: string;
  maxFormatRetries?: number;
}

function resolveDescriptorPath(customPath?: string): string | null {
  if (customPath && existsSync(customPath)) return customPath;
  const envPath = process.env.CODEX_CHATGPT_WEB_HOME || getConfigDir();
  const p1 = join(envPath, "runtime", "launcher-browser.json");
  if (existsSync(p1)) return p1;
  const p2 = join(homedir(), ".codex-m365-copilot", "runtime", "launcher-browser.json");
  if (existsSync(p2)) return p2;
  const p3 = join(homedir(), ".codex-chatgpt-web", "runtime", "launcher-browser.json");
  if (existsSync(p3)) return p3;
  return null;
}

export class ChatGptWebAdapter implements ProviderAdapter {
  readonly name = "chatgpt-web";
  private options: ChatGptAdapterOptions;
  private browserContext: BrowserContext | null = null;
  private activePage: Page | null = null;
  private worker: ChatGptBrowserWorker;

  constructor(options?: ChatGptAdapterOptions) {
    this.options = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-chatgpt-web"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    this.worker = new ChatGptBrowserWorker();
  }

  /**
   * Khởi chạy trình duyệt Google Chrome local nếu không có kết nối Launcher
   */
  private async ensureLocalBrowserPage(): Promise<Page> {
    if (this.activePage && !this.activePage.isClosed()) {
      return this.activePage;
    }

    const profileDir = this.options.userDataDir!;
    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
    }

    console.log(`[chatgpt-adapter] Khởi chạy Google Chrome local với profile: ${profileDir}`);
    this.browserContext = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: this.options.headless,
      viewport: { width: 1280, height: 800 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
      ],
    });

    const pages = this.browserContext.pages();
    this.activePage = pages[0] || (await this.browserContext.newPage());
    return this.activePage;
  }

  /**
   * Biên dịch prompt gửi sang ChatGPT Web bằng kịch bản M365 thống nhất
   */
  private compilePrompt(parsed: CodexParsedRequest, isNewConversation: boolean): string {
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const normalized = CodexPayloadNormalizer.normalize(rawPayload);
    const compiler = new M365PromptCompiler({ assistantName: "ChatGPT" });
    const compileResult = compiler.compile({
      normalized,
      parsed,
      isNewConversation,
      assistantName: "ChatGPT",
    });
    return compileResult.finalPrompt;
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

    // 1. Trích xuất threadId chuẩn xác 100% như M365 Copilot
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const threadId =
      rawPayload.getThreadId() ||
      incoming.headers.get("x-codex-conversation-key") ||
      extractCodexTurnIdentityFromBody(parsed._rawBody || parsed).threadId;

    const conversationKey = chatGptConversationKey(parsed, threadId);
    const turnTraceId = incoming.headers.get("x-codex-trace-id") || randomBytes(12).toString("base64url");

    const descriptorPath = resolveDescriptorPath(this.options.descriptorPath);
    let launcherConnection: LauncherBrowserConnection | null = null;
    let page: Page | null = null;
    let surfaceId: string | undefined;
    let leaseConversationId: string | undefined;
    let finalStatus: "completed" | "failed" | "aborted" = "failed";
    let activeConversationId: string | undefined;

    // 2. Kết nối Launcher Surface qua notifyLauncherTurn (chuẩn M365/Launcher lifecycle)
    if (descriptorPath) {
      try {
        const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
        if (processRunning(descriptor.pid)) {
          console.log(`[chatgpt-adapter] Đăng ký turn với Launcher (phase=start, conversationKey=${conversationKey || 'none'})...`);
          const lease = await notifyLauncherTurn(
            descriptorPath,
            {
              phase: "start",
              traceId: turnTraceId,
              helperPid: process.pid,
              conversationKey,
              connectorIdentity: "chatgpt-web",
              provider: "chatgpt",
              requireRetainedConversation: false,
            },
            undefined,
            incoming.abortSignal,
          );

          surfaceId = lease.surfaceId || descriptor.chatGptSurfaceId || descriptor.surfaceId;
          leaseConversationId = lease.conversationId;
          console.log(`[chatgpt-adapter] Launcher cấp surface: ${surfaceId} (reused=${lease.reused}, convId=${lease.conversationId || 'mới'})`);

          launcherConnection = await connectLauncherBrowserHost(
            descriptorPath,
            20_000,
            surfaceId,
            incoming.abortSignal,
          );
          page = launcherConnection.page;
        }
      } catch (err) {
        console.warn(`[chatgpt-adapter] Không thể kết nối Launcher qua CDP: ${err instanceof Error ? err.message : String(err)}. Sẽ thử local Chrome.`);
      }
    }

    if (!page) {
      page = await this.ensureLocalBrowserPage();
    }

    // 3. Xác định trạng thái hội thoại và kịch bản prompt
    const rawExistingConvId = leaseConversationId || defaultChatGptConversationStore.getConversationId(threadId);
    const existingConversationId = isValidChatGptConversationId(rawExistingConvId) ? rawExistingConvId : undefined;
    activeConversationId = existingConversationId;

    const hasPriorAssistantReply = hasActualPriorAssistantReply(parsed.context.messages);
    const isNewConversation = !hasPriorAssistantReply && !existingConversationId;
    const initialPrompt = this.compilePrompt(parsed, isNewConversation);

    const reasoningEffort = parsed.options.reasoning || "low";
    console.log(`[chatgpt-adapter] Bắt đầu lượt gửi (thread=${threadId || "n/a"}, conv=${existingConversationId || "mới"}, isNew=${isNewConversation}, think=${reasoningEffort})`);

    try {
      const maxRetries = this.options.maxFormatRetries ?? 2;
      let attemptPrompt = initialPrompt;
      let protocolResult: StrictM365ResponseResult | null = null;
      let lastRaw = "";

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (incoming.abortSignal?.aborted) {
          throw new DOMException("ChatGpt turn aborted", "AbortError");
        }

        console.log(`[chatgpt-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`);

        const result = await this.worker.executeTurn(page, {
          prompt: attemptPrompt,
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

        lastRaw = result.rawResponse;
        console.log(`[chatgpt-adapter] Đã nhận rawResponse (${lastRaw.length} ký tự). Đang phân tích strict response...`);

        protocolResult = parseStrictM365Response(lastRaw);

        if (protocolResult.kind === "tool_calls") {
          const clientTools = parsed.context.tools || [];
          for (const call of protocolResult.calls) {
            const normalizedCall = normalizeM365ToolArguments(call.name, call.arguments);
            const validation = validateM365ToolCall(normalizedCall.name, normalizedCall.arguments, clientTools);
            if (!validation.ok) {
              const failure = validation as { ok: false; code: string; message: string };
              protocolResult = {
                kind: "protocol_error",
                code: "INVALID_TOOL_CALL",
                message: `${failure.code}: ${failure.message}`,
                rawResponse: lastRaw,
              };
              break;
            }
          }
        }

        if (protocolResult.kind !== "protocol_error") {
          break;
        }

        console.warn(`[chatgpt-adapter] [Format Error] Lỗi giao thức (${protocolResult.code}): ${protocolResult.message}`);
        if (attempt >= maxRetries) {
          throw new Error(
            `[ChatGPT Format Error] Đã thử ${maxRetries + 1} lần nhưng phản hồi vẫn sai protocol (${protocolResult.code}): ${protocolResult.message}`
          );
        }

        attemptPrompt = buildM365FormatRetryPrompt({
          code: protocolResult.code,
          message: protocolResult.message,
        });
      }

      if (!protocolResult || protocolResult.kind === "protocol_error") {
        throw new Error("[ChatGPT Format Error] Không nhận được response protocol hợp lệ.");
      }

      finalStatus = "completed";

      // 4. Phát sự kiện ra Codex
      if (protocolResult.kind === "final_answer") {
        console.log(`[chatgpt-adapter] Trả về final answer (${protocolResult.content.length} ký tự).`);
        emit({
          type: "text_delta",
          text: protocolResult.content,
        });
      } else if (protocolResult.kind === "tool_calls") {
        console.log(`[chatgpt-adapter] Phát hiện ${protocolResult.calls.length} tool calls hợp lệ.`);
        const clientTools = parsed.context.tools || [];
        for (const rawCall of protocolResult.calls) {
          const mapped = M365ToolBridge.mapToolCall(rawCall, clientTools);
          const callId = rawCall.id || `call_chatgpt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          emit({
            type: "tool_call_start",
            id: callId,
            name: mapped.name,
          });
          emit({
            type: "tool_call_delta",
            arguments: typeof mapped.arguments === "string" ? mapped.arguments : JSON.stringify(mapped.arguments),
          });
          emit({
            type: "tool_call_end",
          });
        }
      }

      emit({
        type: "done",
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
        try {
          const isConvValid = isValidChatGptConversationId(activeConversationId);
          console.log(`[chatgpt-adapter] Báo cáo Launcher kết thúc lượt (phase=end, status=${finalStatus}, retain=true, convId=${isConvValid ? activeConversationId : 'none'})...`);
          await notifyLauncherTurn(descriptorPath, {
            phase: "end",
            traceId: turnTraceId,
            helperPid: process.pid,
            provider: "chatgpt",
            status: finalStatus,
            retain: true,
            connectorBound: finalStatus === "completed" && isConvValid,
            ...(isConvValid ? { conversationId: activeConversationId } : {}),
          });
        } catch (releaseErr) {
          console.warn("[chatgpt-adapter] Không thể gửi phase=end tới launcher:", releaseErr);
        }
      }

      if (launcherConnection) {
        await launcherConnection.browser.close().catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    if (this.browserContext) {
      await this.browserContext.close();
      this.browserContext = null;
      this.activePage = null;
    }
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
