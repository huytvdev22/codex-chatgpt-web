import type { ProviderAdapter, IncomingMeta } from "../base";
import { hasActualPriorAssistantReply } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { geminiBrowserWorker, GeminiBrowserWorker } from "./gemini-browser-worker";
import { GEMINI_SELECTORS, type GeminiDomSelectors } from "./selectors";
import {
  buildUnifiedToolProtocol,
  buildShortOutputFormatAnchor,
  TOOL_REMINDER_PROMPT,
  buildM365FormatRetryPrompt,
  M365PromptCompiler,
} from "../m365-copilot/prompts";
import { resolveGeminiReasoningEffort } from "../../gemini-models";
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
import { createHash, randomBytes } from "node:crypto";
import {
  connectLauncherBrowserHost,
  notifyLauncherTurn,
  readLauncherBrowserHostDescriptor,
  type LauncherBrowserConnection,
} from "../../launcher-browser-host";
import { extractCodexTurnIdentityFromBody } from "../chatgpt-web/environment";
import { getConfigDir } from "../../config";
import { processRunning } from "../../process";

export interface GeminiAdapterOptions {
  userDataDir?: string;
  customSelectors?: Partial<GeminiDomSelectors>;
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

export class GeminiWebAdapter implements ProviderAdapter {
  readonly name = "gemini-web";
  private options: GeminiAdapterOptions;
  private browserContext: BrowserContext | null = null;
  private activePage: Page | null = null;

  constructor(options?: GeminiAdapterOptions) {
    this.options = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-gemini-web"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
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

    console.log(`[gemini-adapter] Khởi chạy Google Chrome local với profile: ${profileDir}`);
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
   * Biên dịch prompt gửi sang Gemini Web từ request của Codex, sử dụng pipeline
   * chuẩn hóa đầy đủ: kèm Available Tools Declarations, trailing tool results,
   * environment context và format anchor thống nhất.
   */
  private compilePrompt(parsed: CodexParsedRequest, isNewConversation: boolean): string {
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const normalized = CodexPayloadNormalizer.normalize(rawPayload);
    const compiler = new M365PromptCompiler({ assistantName: "Gemini" });
    const compileResult = compiler.compile({
      normalized,
      parsed,
      isNewConversation,
      assistantName: "Gemini",
    });
    return compileResult.finalPrompt;
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

    const descriptorPath = resolveDescriptorPath(this.options.descriptorPath);
    let launcherConnection: LauncherBrowserConnection | null = null;
    let page: Page | null = null;
    let leaseStarted = false;
    let finalStatus: "completed" | "failed" | "aborted" = "failed";

    if (descriptorPath) {
      let launcherError: Error | null = null;
      try {
        const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
        if (processRunning(descriptor.pid)) {
          const lease = await notifyLauncherTurn(
            descriptorPath,
            {
              phase: "start",
              traceId: turnTraceId,
              helperPid: process.pid,
              conversationKey,
              connectorIdentity: "gemini-web",
              provider: "gemini",
              requireRetainedConversation: false,
            },
            undefined,
            incoming.abortSignal,
          );
          leaseStarted = true;
          const targetSurfaceId = lease.surfaceId || descriptor.geminiSurfaceId || descriptor.surfaceId;
          console.log(`[gemini-adapter] Kết nối Playwright qua Launcher CDP (pid=${descriptor.pid}, surface=${targetSurfaceId})...`);
          launcherConnection = await connectLauncherBrowserHost(
            descriptorPath,
            20_000,
            targetSurfaceId,
            incoming.abortSignal,
          );
          page = launcherConnection.page;
        }
      } catch (err) {
        launcherError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[gemini-adapter] Không thể kết nối Launcher qua CDP: ${launcherError.message}. Sẽ thử local Chrome.`);
      }
    }

    if (!page) {
      page = await this.ensureLocalBrowserPage();
    }

    const hasPriorAssistantReply = hasActualPriorAssistantReply(parsed.context.messages);
    const isNewConversation = !hasPriorAssistantReply;
    const initialPrompt = this.compilePrompt(parsed, isNewConversation);
    const reasoningEffort = resolveGeminiReasoningEffort(parsed.modelId, parsed.options.reasoning);

    console.log(`[gemini-adapter] Bắt đầu lượt gửi cho model: ${parsed.modelId}, cấp độ tư duy: ${reasoningEffort || "mặc định"}`);

    try {
      const maxRetries = this.options.maxFormatRetries ?? 2;
      let attemptPrompt = initialPrompt;
      let protocolResult: StrictM365ResponseResult | null = null;
      let lastRaw = "";

      // Vòng lặp Quarantine và Format Retry
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (incoming.abortSignal?.aborted) {
          throw new DOMException("Gemini turn aborted", "AbortError");
        }

        console.log(`[gemini-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`);

        const result = await geminiBrowserWorker.executeTurn(page, {
          prompt: attemptPrompt,
          signal: incoming.abortSignal,
          modelSlug: parsed.modelId,
          reasoningEffort,
          customSelectors: this.options.customSelectors,
          // Quarantine: không emit chunk trực tiếp ra Codex trong lúc stream để tránh leak protocol XML
          onChunk: () => {},
        });

        lastRaw = result.rawResponse;
        console.log(`[gemini-adapter] Đã nhận rawResponse (${lastRaw.length} ký tự). Áp dụng strict-parser...`);

        protocolResult = parseStrictM365Response(lastRaw);

        if (protocolResult.kind === "tool_calls") {
          // Validate từng tool call theo danh sách tools của client
          const clientTools = parsed.context.tools || [];
          for (const call of protocolResult.calls) {
            const normalizedCall = normalizeM365ToolArguments(call.name, call.arguments);
            const validation = validateM365ToolCall(normalizedCall.name, normalizedCall.arguments, clientTools);
            if (!validation.ok) {
              protocolResult = {
                kind: "protocol_error",
                code: "INVALID_TOOL_CALL",
                message: `${validation.code}: ${validation.message}`,
                rawResponse: lastRaw,
              };
              break;
            }
          }
        }

        if (protocolResult.kind !== "protocol_error") {
          break;
        }

        console.warn(`[gemini-adapter] [Format Error] Lỗi giao thức (${protocolResult.code}): ${protocolResult.message}`);
        if (attempt >= maxRetries) {
          throw new Error(
            `[Gemini Format Error] Đã thử ${maxRetries + 1} lần nhưng phản hồi vẫn sai protocol (${protocolResult.code}): ${protocolResult.message}`
          );
        }

        // Tạo lời nhắc sửa format cho Gemini tự sửa trong lần thử tiếp theo
        attemptPrompt = buildM365FormatRetryPrompt({
          code: protocolResult.code,
          message: protocolResult.message,
        });
      }

      if (!protocolResult || protocolResult.kind === "protocol_error") {
        throw new Error("[Gemini Format Error] Không nhận được response protocol hợp lệ.");
      }

      // Phát sự kiện ra Codex
      if (protocolResult.kind === "final_answer") {
        console.log(`[gemini-adapter] Trả về final answer (${protocolResult.content.length} ký tự).`);
        emit({
          type: "text_delta",
          text: protocolResult.content,
        });
      } else if (protocolResult.kind === "tool_calls") {
        console.log(`[gemini-adapter] Phát hiện ${protocolResult.calls.length} tool calls hợp lệ.`);
        const clientTools = parsed.context.tools || [];
        for (const rawCall of protocolResult.calls) {
          const mapped = M365ToolBridge.mapToolCall(rawCall, clientTools);
          const callId = rawCall.id || `call_gemini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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

export function createGeminiWebAdapter(options?: GeminiAdapterOptions): GeminiWebAdapter {
  return new GeminiWebAdapter(options);
}

export * from "./selectors";
export * from "./gemini-browser-worker";
