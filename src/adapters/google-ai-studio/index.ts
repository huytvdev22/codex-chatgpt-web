import type { ProviderAdapter, IncomingMeta } from "../base";
import { hasActualPriorAssistantReply } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { GoogleAIStudioBrowserWorker } from "./browser-worker";
import { parseGoogleAIStudioPromptId, AI_STUDIO_SELECTORS } from "./selectors";
import {
  defaultGoogleAIStudioConversationStore,
  googleAIStudioConversationKey,
} from "./conversation-store";
import { extractCodexTurnIdentityFromBody } from "../chatgpt-web/environment";
import {
  promptCompiler,
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
  type ToolValidationFailure,
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

function resolveDescriptorPath(customPath?: string): string | null {
  if (customPath && existsSync(customPath)) return customPath;
  const envPath = process.env.CODEX_CHATGPT_WEB_HOME || getConfigDir();
  const p1 = join(envPath, "runtime", "launcher-browser.json");
  if (existsSync(p1)) return p1;
  const p2 = join(homedir(), ".codex-google-ai-studio", "runtime", "launcher-browser.json");
  if (existsSync(p2)) return p2;
  const p3 = join(homedir(), ".codex-m365-copilot", "runtime", "launcher-browser.json");
  if (existsSync(p3)) return p3;
  const p4 = join(homedir(), ".codex-chatgpt-web", "runtime", "launcher-browser.json");
  if (existsSync(p4)) return p4;
  return null;
}

export class GoogleAIStudioAdapter implements ProviderAdapter {
  readonly name = "google-ai-studio";
  private options: GoogleAIStudioAdapterOptions;
  private browserContext: BrowserContext | null = null;
  private activePage: Page | null = null;
  private worker: GoogleAIStudioBrowserWorker;

  constructor(options?: GoogleAIStudioAdapterOptions) {
    this.options = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-google-ai-studio"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    this.worker = new GoogleAIStudioBrowserWorker();
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

    console.log(`[ai-studio-adapter] Khởi chạy Google Chrome local với profile: ${profileDir}`);
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

    const descriptorPath = resolveDescriptorPath(this.options.descriptorPath);
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
        const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
        if (processRunning(descriptor.pid)) {
          console.log(`[ai-studio-adapter] Đăng ký turn với Launcher (conversationKey=${conversationKey || 'none'})...`);
          const lease = await notifyLauncherTurn(
            descriptorPath,
            {
              phase: "start",
              traceId: turnTraceId,
              helperPid: process.pid,
              conversationKey,
              connectorIdentity: "google-ai-studio",
              provider: "google-ai-studio",
              requireRetainedConversation: false,
            },
            undefined,
            incoming.abortSignal,
          );

          surfaceId = lease.surfaceId || descriptor.surfaceId;
          leasePromptId = lease.conversationId;
          launcherConversationReused = lease.reused === true;
          launcherConnection = await connectLauncherBrowserHost(
            descriptorPath,
            20_000,
            surfaceId,
            incoming.abortSignal,
          );
          page = launcherConnection.page;
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
      page = await this.ensureLocalBrowserPage();
    }

    // 3. Xác định trạng thái hội thoại và kịch bản prompt
    const storedPromptId = conversationKey ? defaultGoogleAIStudioConversationStore.get(conversationKey) : undefined;
    const existingPromptId = leasePromptId || storedPromptId;
    const hasPriorAssistantReply = hasActualPriorAssistantReply(parsed.context.messages);
    const isNewConversation = !launcherConversationReused && !hasPriorAssistantReply && !existingPromptId;

    // Biên dịch prompt chuẩn M365 (Tool Protocol)
    const normalized = CodexPayloadNormalizer.normalize(rawPayload);
    const compileResult = promptCompiler.compile({
      normalized,
      parsed,
      isNewConversation,
    });
    const initialPrompt = compileResult.finalPrompt;
    const reasoningEffort = parsed.options.reasoning || "medium";

    console.log(`[ai-studio-adapter] Bắt đầu lượt gửi (thread=${threadId || "n/a"}, promptId=${existingPromptId || "mới"}, isNew=${isNewConversation})`);

    let finalPromptId = existingPromptId;
    let protocolResult: StrictM365ResponseResult | null = null;
    try {
      const maxRetries = this.options.maxFormatRetries ?? 2;
      let attemptPrompt = initialPrompt;
      let lastRaw = "";

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (incoming.abortSignal?.aborted) {
          throw new DOMException("Google AI Studio turn aborted", "AbortError");
        }

        console.log(`[ai-studio-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`);

        const result = await this.worker.executeTurn(page, {
          prompt: attemptPrompt,
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

        // Làm sạch toàn bộ tiền tố rác và hậu tố rác trước khi parse
        lastRaw = sanitizeAIStudioResponse(result.rawResponse);
        console.log(`[ai-studio-adapter] Đã nhận rawResponse (${lastRaw.length} ký tự). Đang phân tích strict response...`);

        protocolResult = parseStrictM365Response(lastRaw);

        // Tolerant Answers: Nếu phản hồi là văn bản tự nhiên hợp lệ (chỉ thiếu transport fence 4-backtick hoặc webResponse)
        // và không chứa bất kỳ hành vi gọi công cụ nào, chấp nhận ngay là final_answer
        if (protocolResult.kind === "protocol_error") {
          const isWrapperError =
            protocolResult.code === "MISSING_TRANSPORT_FENCE" ||
            protocolResult.code === "MISSING_RESPONSE_ENVELOPE";
          const hasActionMarkers =
            lastRaw.includes("<tool_call>") ||
            lastRaw.includes("<custom_tool_call") ||
            lastRaw.includes("*** Begin Patch");

          if (isWrapperError && !hasActionMarkers && lastRaw.trim().length > 0) {
            console.log(`[ai-studio-adapter] Tolerant Answers: Chấp nhận phản hồi văn bản tự nhiên (${lastRaw.length} ký tự) làm final_answer.`);
            protocolResult = {
              kind: "final_answer",
              content: lastRaw.replace(/<\/?webResponse>/gi, "").trim(),
              rawResponse: lastRaw,
            };
          }
        }

        if (protocolResult.kind === "tool_calls") {
          const clientTools = parsed.context.tools || [];
          for (const call of protocolResult.calls) {
            const normalizedCall = normalizeM365ToolArguments(call.name, call.arguments);
            const validation = validateM365ToolCall(normalizedCall.name, normalizedCall.arguments, clientTools);
            if (!validation.ok) {
              const failure = validation as ToolValidationFailure;
              const isDisallowed = failure.message.includes("vi phạm quy tắc an toàn");
              const isUnknown = failure.code === "UNKNOWN_TOOL";
              protocolResult = {
                kind: "protocol_error",
                code: isDisallowed
                  ? "DISALLOWED_COMMAND"
                  : isUnknown
                    ? "UNKNOWN_TOOL"
                    : "INVALID_TOOL_CALL",
                message: `${failure.code}: ${failure.message}`,
                rawResponse: lastRaw,
              };
              break;
            }
          }
        }

        if (protocolResult.kind !== "protocol_error") break;

        // Trường hợp parse lỗi (unrecognized), thử retry nếu còn lượt
        if (attempt < maxRetries) {
          console.warn(`[ai-studio-adapter] Không thể trích xuất cấu trúc chuẩn từ phản hồi, kích hoạt Retry Prompt...`);
          attemptPrompt = buildM365FormatRetryPrompt({
            code: protocolResult.code,
            message: protocolResult.message,
          });
        }
      }

      const inputTokens = Math.ceil(initialPrompt.length / 4);
      const outputTokens = Math.ceil((lastRaw.length || 10) / 4);
      const usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };

      if (protocolResult && protocolResult.kind === "tool_calls") {
        const clientTools = parsed.context.tools || [];
        const mappedCalls = protocolResult.calls.map(rawCall => ({
          rawCall,
          mapped: M365ToolBridge.mapToolCall(rawCall, clientTools),
          callId: rawCall.id || `call_${randomBytes(8).toString("hex")}`,
        }));

        for (const { mapped, callId } of mappedCalls) {
          const serializedArgs = typeof mapped.arguments === "string"
            ? mapped.arguments
            : JSON.stringify(mapped.arguments ?? {});

          emit({ type: "tool_call_start", id: callId, name: mapped.name });
          emit({ type: "tool_call_delta", arguments: serializedArgs });
          emit({ type: "tool_call_end" });
        }
        emit({ type: "done", stopReason: "tool_calls", usage });
        return;
      }

      if (protocolResult && protocolResult.kind === "final_answer") {
        emit({ type: "text_delta", text: protocolResult.content });
        emit({ type: "done", stopReason: "stop", endTurn: true, usage });
        return;
      }

      // Fallback nếu không khớp envelope: dọn sạch thẻ <webResponse> nếu có trước khi emit
      const cleanFallback = lastRaw.replace(/<\/?webResponse>/gi, "").trim();
      emit({ type: "text_delta", text: cleanFallback });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage });
    } finally {
      if (descriptorPath && surfaceId) {
        try {
          const finalStatus = protocolResult && protocolResult.kind !== "protocol_error" ? "completed" : "failed";
          await notifyLauncherTurn(
            descriptorPath,
            {
              phase: "end",
              traceId: turnTraceId,
              helperPid: process.pid,
              status: finalStatus,
              conversationId: finalPromptId || conversationKey,
              provider: "google-ai-studio",
              retain: true,
              connectorBound: true,
            },
            undefined,
            incoming.abortSignal,
          );
        } catch {
          // Bỏ qua lỗi notify launcher lúc kết thúc
        }
      }
    }
  }
}

export function createGoogleAIStudioAdapter(options?: GoogleAIStudioAdapterOptions): ProviderAdapter {
  return new GoogleAIStudioAdapter(options);
}
