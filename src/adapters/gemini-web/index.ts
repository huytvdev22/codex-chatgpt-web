import type { ProviderAdapter, IncomingMeta } from "../base";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { geminiBrowserWorker, GeminiBrowserWorker } from "./gemini-browser-worker";
import { GEMINI_SELECTORS, type GeminiDomSelectors } from "./selectors";
import {
  GEMINI_TOOL_PROTOCOL,
  GEMINI_PLAN_MODE_PROMPT,
  GEMINI_IMPLEMENT_PLAN_PROMPT,
  GEMINI_TOOL_REMINDER_PROMPT,
  GEMINI_SHORT_OUTPUT_FORMAT_ANCHOR,
} from "./prompts/templates";
import { XmlToolCallDetector } from "../m365-copilot/translation/detectors/xml-detector";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export interface GeminiAdapterOptions {
  userDataDir?: string;
  customSelectors?: Partial<GeminiDomSelectors>;
  headless?: boolean;
}

export class GeminiWebAdapter implements ProviderAdapter {
  readonly name = "gemini-web";
  private options: GeminiAdapterOptions;
  private xmlDetector = new XmlToolCallDetector();
  private browserContext: BrowserContext | null = null;
  private activePage: Page | null = null;

  constructor(options?: GeminiAdapterOptions) {
    this.options = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-gemini-web"),
      headless: options?.headless ?? false,
      ...options,
    };
  }

  /**
   * Đảm bảo trình duyệt Chromium với profile lưu phiên đăng nhập của Google đã sẵn sàng
   */
  private async ensureBrowserPage(): Promise<Page> {
    if (this.activePage && !this.activePage.isClosed()) {
      return this.activePage;
    }

    const profileDir = this.options.userDataDir!;
    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
    }

    console.log(`[gemini-adapter] Khởi chạy Chromium với profile: ${profileDir}`);
    this.browserContext = await chromium.launchPersistentContext(profileDir, {
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
   * Biên dịch prompt gửi sang Gemini Web từ request của Codex
   */
  private compilePrompt(parsed: CodexParsedRequest): string {
    const sections: string[] = [];
    const isNew = !parsed.context.messages?.some(m => m.role === "assistant");

    // 1. Thỏa thuận giao thức nếu là phiên mới
    if (isNew) {
      sections.push(GEMINI_TOOL_PROTOCOL);
    } else {
      sections.push(GEMINI_TOOL_REMINDER_PROMPT);
    }

    // 2. Nội dung trao đổi từ người dùng
    const userMsgs = (parsed.context.messages || [])
      .filter(m => m.role === "user")
      .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));

    if (userMsgs.length > 0) {
      sections.push(`[Yêu cầu của mình]:\n${userMsgs[userMsgs.length - 1]}`);
    }

    sections.push(GEMINI_SHORT_OUTPUT_FORMAT_ANCHOR);
    return sections.filter(Boolean).join("\n\n");
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

    const page = await this.ensureBrowserPage();
    const prompt = this.compilePrompt(parsed);

    console.log(`[gemini-adapter] Bắt đầu lượt gửi cho model: ${parsed.modelId}`);

    try {
      const result = await geminiBrowserWorker.executeTurn(page, {
        prompt,
        signal: incoming.abortSignal,
        modelSlug: parsed.modelId,
        customSelectors: this.options.customSelectors,
        onChunk: (chunkText) => {
          emit({
            type: "text_delta",
            text: chunkText,
          });
        },
      });

      // Bóc tách tool call nếu có trong câu trả lời
      const detected = this.xmlDetector.detect(result.rawResponse);
      const toolCalls = Array.isArray(detected) ? detected : detected ? [detected] : [];

      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const callId = `call_gemini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          emit({
            type: "tool_call_start",
            id: callId,
            name: tc.name,
          });
          emit({
            type: "tool_call_delta",
            arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
          });
          emit({
            type: "tool_call_end",
          });
        }
      }

      emit({
        type: "done",
      });

      console.log(`[gemini-adapter] Kết thúc lượt. Phát hiện ${toolCalls.length} tool calls.`);
    } catch (error) {
      console.error("[gemini-adapter] Lỗi trong quá trình thực thi lượt:", error);
      emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
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
