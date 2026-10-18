import type { ProviderAdapter, IncomingMeta } from "../base";
import { hasActualPriorAssistantReply } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { QwenBrowserWorker } from "./qwen-browser-worker";
import { isValidQwenConversationId } from "./selectors";
import { defaultQwenConversationStore, qwenConversationKey } from "./conversation-store";
import { extractCodexTurnIdentityFromBody } from "../chatgpt-web/environment";
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

export interface QwenAdapterOptions {
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

export class QwenWebAdapter implements ProviderAdapter {
  readonly name = "qwen-web";
  private options: QwenAdapterOptions;
  private browserContext: BrowserContext | null = null;
  private activePage: Page | null = null;
  private worker: QwenBrowserWorker;

  constructor(options?: QwenAdapterOptions) {
    this.options = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-qwen-web"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    this.worker = new QwenBrowserWorker();
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

    console.log(`[qwen-adapter] Khởi chạy Google Chrome local với profile: ${profileDir}`);
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
   * Biên dịch prompt gửi sang Qwen Web bằng kịch bản tương tác thống nhất
   */
  private compilePrompt(parsed: CodexParsedRequest, isNewConversation: boolean): string {
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const normalized = CodexPayloadNormalizer.normalize(rawPayload);
    const compiler = new M365PromptCompiler({ assistantName: "Qwen" });
    const compileResult = compiler.compile({
      normalized,
      parsed,
      isNewConversation,
      assistantName: "Qwen",
    });
    return compileResult.finalPrompt;
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

    // 1. Trích xuất threadId
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const threadId =
      rawPayload.getThreadId() ||
      incoming.headers.get("x-codex-conversation-key") ||
      extractCodexTurnIdentityFromBody(parsed._rawBody || parsed).threadId;

    const conversationKey = qwenConversationKey(parsed, threadId);
    const turnTraceId = incoming.headers.get("x-codex-trace-id") || randomBytes(12).toString("base64url");

    const descriptorPath = resolveDescriptorPath(this.options.descriptorPath);
    let launcherConnection: LauncherBrowserConnection | null = null;
    let page: Page | null = null;
    let surfaceId: string | undefined;
    let leaseConversationId: string | undefined;
    let finalStatus: "completed" | "failed" | "aborted" = "failed";
    let activeConversationId: string | undefined;

    // 2. Kết nối Launcher Surface nếu có
    if (descriptorPath) {
      try {
        const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
        if (processRunning(descriptor.pid)) {
          console.log(`[qwen-adapter] Đăng ký turn với Launcher (phase=start, conversationKey=${conversationKey || 'none'})...`);
          const lease = await notifyLauncherTurn(
            descriptorPath,
            {
              phase: "start",
              traceId: turnTraceId,
              helperPid: process.pid,
              conversationKey,
              connectorIdentity: "qwen-web",
              provider: "qwen" as any,
              requireRetainedConversation: false,
            },
            undefined,
            incoming.abortSignal,
          );

          surfaceId = lease.surfaceId || (descriptor as any).qwenSurfaceId || descriptor.surfaceId;
          leaseConversationId = lease.conversationId;
          console.log(`[qwen-adapter] Launcher cấp surface: ${surfaceId} (reused=${lease.reused}, convId=${lease.conversationId || 'mới'})`);

          launcherConnection = await connectLauncherBrowserHost(
            descriptorPath,
            20_000,
            surfaceId,
            incoming.abortSignal,
          );
          page = launcherConnection.page;
        }
      } catch (err) {
        console.warn(`[qwen-adapter] Không thể kết nối Launcher qua CDP: ${err instanceof Error ? err.message : String(err)}. Sẽ thử local Chrome.`);
      }
    }

    if (!page) {
      if (descriptorPath) {
        throw new Error("[qwen-adapter] Không thể kết nối với Launcher browser tab.");
      }
      page = await this.ensureLocalBrowserPage();
    }

    // 3. Xác định trạng thái hội thoại
    const hasPriorAssistantReply = hasActualPriorAssistantReply(parsed.context.messages);
    const isNewConversation = !hasPriorAssistantReply;

    const rawExistingConvId = isNewConversation
      ? undefined
      : (leaseConversationId || defaultQwenConversationStore.getConversationId(threadId));
    const existingConversationId = isValidQwenConversationId(rawExistingConvId || "") ? rawExistingConvId : undefined;
    activeConversationId = existingConversationId;

    const initialPrompt = this.compilePrompt(parsed, isNewConversation);

    const reasoningEffort = parsed.options.reasoning || "low";
    console.log(`[qwen-adapter] Bắt đầu lượt gửi (thread=${threadId || "n/a"}, conv=${existingConversationId || "mới"}, isNew=${isNewConversation})`);

    try {
      const maxRetries = this.options.maxFormatRetries ?? 2;
      let attemptPrompt = initialPrompt;
      let protocolResult: StrictM365ResponseResult | null = null;
      let lastRaw = "";

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (incoming.abortSignal?.aborted) {
          throw new DOMException("Qwen turn aborted", "AbortError");
        }

        console.log(`[qwen-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`);

        const result = await this.worker.executeTurn(page, {
          prompt: attemptPrompt,
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

        lastRaw = result.rawResponse;
        console.log(`[qwen-adapter] Đã nhận rawResponse (${lastRaw.length} ký tự). Đang phân tích strict response...`);

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

        console.warn(`[qwen-adapter] [Format Error] Lỗi giao thức (${protocolResult.code}): ${protocolResult.message}`);
        if (attempt >= maxRetries) {
          throw new Error(
            `[Qwen Format Error] Đã thử ${maxRetries + 1} lần nhưng phản hồi vẫn sai protocol (${protocolResult.code}): ${protocolResult.message}`
          );
        }

        attemptPrompt = buildM365FormatRetryPrompt({
          code: protocolResult.code,
          message: protocolResult.message,
        });
      }

      if (!protocolResult || protocolResult.kind === "protocol_error") {
        throw new Error("[Qwen Format Error] Không nhận được response protocol hợp lệ.");
      }

      // 4. Phát các sự kiện cho Codex Server & Bridge
      if (protocolResult.kind === "tool_calls") {
        console.log(`[qwen-adapter] Qwen yêu cầu gọi ${protocolResult.calls.length} công cụ.`);
        for (const call of protocolResult.calls) {
          const normalized = normalizeM365ToolArguments(call.name, call.arguments);
          emit({
            type: "tool_call",
            callId: call.callId,
            toolName: normalized.name,
            arguments: JSON.stringify(normalized.arguments),
          });
        }
      } else if (protocolResult.kind === "final_answer") {
        console.log(`[qwen-adapter] Qwen đã hoàn tất câu trả lời (${protocolResult.content.length} ký tự).`);
        emit({
          type: "text_chunk",
          delta: protocolResult.content,
        });
      }

      emit({ type: "turn_completed" });
      finalStatus = "completed";
    } catch (error) {
      finalStatus = incoming.abortSignal?.aborted ? "aborted" : "failed";
      throw error;
    } finally {
      // 5. Thông báo kết thúc turn với Launcher
      if (descriptorPath && launcherConnection) {
        try {
          await notifyLauncherTurn(
            descriptorPath,
            {
              phase: "finish",
              traceId: turnTraceId,
              helperPid: process.pid,
              conversationKey,
              connectorIdentity: "qwen-web",
              provider: "qwen" as any,
              status: finalStatus,
              conversationId: activeConversationId,
              surfaceId,
            },
            undefined,
            undefined,
          );
        } catch {}
        await launcherConnection.disconnect().catch(() => {});
      }
    }
  }

  async abortTurn(): Promise<void> {
    if (this.activePage && !this.activePage.isClosed()) {
      await this.activePage.locator(QWEN_SELECTORS.stopButton).first().click().catch(() => {});
    }
  }

  async cleanup(): Promise<void> {
    if (this.browserContext) {
      await this.browserContext.close().catch(() => {});
      this.browserContext = null;
      this.activePage = null;
    }
  }
}

export function createQwenWebAdapter(options?: QwenAdapterOptions): ProviderAdapter {
  return new QwenWebAdapter(options);
}
