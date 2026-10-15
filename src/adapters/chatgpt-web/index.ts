import type { ProviderAdapter, IncomingMeta } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { chatGptBrowserWorker, ChatGptBrowserWorker } from "./chatgpt-browser-worker";
import { CHATGPT_SELECTORS, type ChatGptDomSelectors } from "./selectors";
import {
  buildUnifiedToolProtocol,
  buildShortOutputFormatAnchor,
  TOOL_REMINDER_PROMPT,
  buildM365FormatRetryPrompt,
  M365PromptCompiler,
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
import {
  connectLauncherBrowserHost,
  readLauncherBrowserHostDescriptor,
  type LauncherBrowserConnection,
} from "../../launcher-browser-host";
import { getConfigDir } from "../../config";
import { processRunning } from "../../process";

export function resolveChatGptEffort(
  _modelId: string,
  requestedReasoning?: string
): "low" | "medium" | "high" | "xhigh" | "max" {
  if (requestedReasoning) {
    const effort = requestedReasoning.trim().toLowerCase();
    if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") {
      return effort as "low" | "medium" | "high" | "xhigh" | "max";
    }
  }
  return "medium";
}

export interface ChatGptAdapterOptions {
  userDataDir?: string;
  customSelectors?: Partial<ChatGptDomSelectors>;
  headless?: boolean;
  descriptorPath?: string;
  maxFormatRetries?: number;
  [key: string]: any;
}

function resolveDescriptorPath(customPath?: string): string | null {
  if (customPath && existsSync(customPath)) return customPath;
  const standardPath = join(getConfigDir(), "runtime", "launcher-browser.json");
  return existsSync(standardPath) ? standardPath : null;
}

/**
 * Adapter ChatGPT Web chuẩn hóa theo kiến trúc Unified Web Adapter (giống Gemini Web và M365 Copilot).
 * Kết nối CDP trực tiếp vào Launcher WebContentsView, 100% không dùng tunnel, không proxy bên thứ 3.
 */
export class ChatGptWebAdapter implements ProviderAdapter {
  readonly name = "chatgpt-web";
  private browserContext: BrowserContext | null = null;
  private activePage: Page | null = null;

  constructor(private options: ChatGptAdapterOptions = {}) {}

  /**
   * Tạo Chrome context local khi Launcher không chạy
   */
  private async ensureLocalBrowserPage(): Promise<Page> {
    if (this.activePage && !this.activePage.isClosed()) {
      return this.activePage;
    }

    const defaultProfileDir = join(
      this.options.userDataDir || join(homedir(), ".codex-m365-copilot", "chatgpt-profile")
    );
    if (!existsSync(defaultProfileDir)) {
      mkdirSync(defaultProfileDir, { recursive: true });
    }

    console.log(`[chatgpt-adapter] Khởi chạy Chrome local với profile: ${defaultProfileDir}`);
    this.browserContext = await chromium.launchPersistentContext(defaultProfileDir, {
      channel: "chrome",
      headless: this.options.headless ?? false,
      viewport: { width: 1280, height: 800 },
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });

    const pages = this.browserContext.pages();
    this.activePage = pages[0] || (await this.browserContext.newPage());
    await this.activePage.goto(this.options.customSelectors?.appUrl || CHATGPT_SELECTORS.appUrl);
    return this.activePage;
  }

  /**
   * Biên dịch prompt gửi sang ChatGPT Web từ request của Codex, sử dụng pipeline
   * chuẩn hóa đầy đủ: kèm Available Tools Declarations, trailing tool results,
   * environment context và format anchor thống nhất.
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
   * Điều phối một lượt tương tác (turn) giữa Codex và ChatGPT Web
   */
  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void
  ): Promise<void> {
    if (incoming.abortSignal?.aborted) {
      throw new DOMException("ChatGpt turn aborted before start", "AbortError");
    }

    const descriptorPath = resolveDescriptorPath(this.options.descriptorPath);
    let launcherConnection: LauncherBrowserConnection | null = null;
    let page: Page | null = null;

    if (descriptorPath) {
      try {
        const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
        if (processRunning(descriptor.pid)) {
          // Ưu tiên chatGptSurfaceId, fallback surfaceId
          const targetSurfaceId = descriptor.chatGptSurfaceId || descriptor.surfaceId;
          console.log(`[chatgpt-adapter] Kết nối Playwright qua Launcher CDP (pid=${descriptor.pid}, surface=${targetSurfaceId})...`);
          launcherConnection = await connectLauncherBrowserHost(
            descriptorPath,
            20_000,
            targetSurfaceId,
            incoming.abortSignal
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

    const hasPriorAssistantReply = (parsed.context.messages || []).some((m) => m.role === "assistant");
    const isNewConversation = !hasPriorAssistantReply;
    const initialPrompt = this.compilePrompt(parsed, isNewConversation);
    const reasoningEffort = resolveChatGptEffort(parsed.modelId, parsed.options.reasoning);

    console.log(`[chatgpt-adapter] Bắt đầu lượt gửi cho model: ${parsed.modelId}, cấp độ tư duy: ${reasoningEffort || "mặc định"}`);

    try {
      const maxRetries = this.options.maxFormatRetries ?? 2;
      let attemptPrompt = initialPrompt;
      let protocolResult: StrictM365ResponseResult | null = null;
      let lastRaw = "";

      // Vòng lặp Quarantine và Format Retry
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (incoming.abortSignal?.aborted) {
          throw new DOMException("ChatGpt turn aborted", "AbortError");
        }

        console.log(`[chatgpt-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`);

        const result = await chatGptBrowserWorker.executeTurn(page, {
          prompt: attemptPrompt,
          signal: incoming.abortSignal,
          modelSlug: parsed.modelId,
          reasoningEffort,
          customSelectors: this.options.customSelectors,
          // Quarantine: không emit chunk trực tiếp ra Codex trong lúc stream để tránh leak protocol XML
          onChunk: () => {},
        });

        lastRaw = result.rawResponse;
        console.log(`[chatgpt-adapter] Đã nhận rawResponse (${lastRaw.length} ký tự). Áp dụng strict-parser...`);

        protocolResult = parseStrictM365Response(lastRaw);

        if (protocolResult.kind === "tool_calls") {
          // Validate từng tool call theo danh sách tools của client
          const clientTools = parsed.context.tools || [];
          for (const call of protocolResult.calls) {
            const normalizedCall = normalizeM365ToolArguments(call.name, call.arguments);
            const validation = validateM365ToolCall(normalizedCall.name, normalizedCall.arguments, clientTools);
            if (!validation.ok) {
              const fail = validation as { ok: false; code: string; message: string };
              protocolResult = {
                kind: "protocol_error",
                code: "INVALID_TOOL_CALL",
                message: `${fail.code}: ${fail.message}`,
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
            `[ChatGpt Format Error] Đã thử ${maxRetries + 1} lần nhưng phản hồi vẫn sai protocol (${protocolResult.code}): ${protocolResult.message}`
          );
        }

        // Tạo lời nhắc sửa format cho ChatGPT tự sửa trong lần thử tiếp theo
        attemptPrompt = buildM365FormatRetryPrompt({
          code: protocolResult.code,
          message: protocolResult.message,
        });
      }

      if (!protocolResult || protocolResult.kind === "protocol_error") {
        throw new Error("[ChatGpt Format Error] Không nhận được response protocol hợp lệ.");
      }

      // Phát sự kiện ra Codex
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
      console.error("[chatgpt-adapter] Lỗi trong quá trình thực thi lượt:", error);
      emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async close(): Promise<void> {
    if (this.browserContext) {
      try {
        await this.browserContext.close();
      } catch {}
      this.browserContext = null;
      this.activePage = null;
    }
  }
}

export function createChatGptWebAdapter(options?: ChatGptAdapterOptions, _legacyConfig?: unknown): ChatGptWebAdapter {
  return new ChatGptWebAdapter(options);
}

// Helper tương thích ngược cho trace ID
export function chatGptWebTraceId(headers?: Headers | unknown, _parsed?: unknown): string {
  const h = headers instanceof Headers ? headers : undefined;
  return (
    h?.get("x-codex-trace-id") ||
    `chatgpt_trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
}
