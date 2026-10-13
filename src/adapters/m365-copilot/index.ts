import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { IncomingMeta } from "../base";
import {
  BaseWebChatAdapter,
  TurnExecutionMetaDto,
  ResponseTranslationResultDto,
  CodexRawPayload,
  CodexPayloadNormalizer,
  BasePromptCompiler,
  BaseOutputTranslator,
  buildM365FormatRetryPrompt,
  BaseTitleGuard,
  ConversationLoopGuard,
} from "../base-web";
import {
  M365BrowserWorker,
  defaultM365BrowserWorker,
} from "./browser/m365-browser-worker";
import {
  M365CapabilityPicker,
  defaultM365CapabilityPicker,
  M365_CAPABILITY_SPECS,
  type M365CapabilityMode,
  type M365CapabilitySpec,
} from "./browser/m365-capability-specs";
import {
  M365_CHAT_URL,
  parseM365ConversationId,
  waitForM365ConversationId,
} from "./browser/conversation-url";

export {
  M365BrowserWorker,
  defaultM365BrowserWorker,
  M365CapabilityPicker,
  defaultM365CapabilityPicker,
  M365_CAPABILITY_SPECS,
  type M365CapabilityMode,
  type M365CapabilitySpec,
  M365_CHAT_URL,
  parseM365ConversationId,
  waitForM365ConversationId,
};

/**
 * Sinh conversationKey SHA-256 ổn định gắn liền với cấu hình model của request
 */
export function m365ConversationKey(
  parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  const source = rawConversationKey?.trim();
  if (!source) return undefined;

  return createHash("sha256").update(JSON.stringify({
    provider: "m365-copilot",
    source,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
  })).digest("hex");
}

/**
 * Adapter Microsoft 365 Copilot tinh gọn kế thừa BaseWebChatAdapter
 * Chỉ nắm giữ cấu hình riêng của M365 và tận dụng 100% pipeline chung từ BaseWeb
 */
export class M365CopilotAdapter extends BaseWebChatAdapter {
  readonly name = "m365-copilot";
  readonly browserWorker = defaultM365BrowserWorker;
  readonly modelSelector = defaultM365CapabilityPicker;

  private readonly promptCompiler = new BasePromptCompiler();
  private readonly outputTranslator = new BaseOutputTranslator();
  private readonly titleGuard = new BaseTitleGuard();
  private readonly loopGuard = new ConversationLoopGuard();

  constructor(readonly options?: { enableTitleGuard?: boolean }) {
    super();
  }

  protected resolveExecutionMeta(parsed: CodexParsedRequest, incoming: IncomingMeta): TurnExecutionMetaDto {
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const rawConversationKey = incoming.headers.get("x-codex-conversation-key")
      || rawPayload.getThreadId()
      || undefined;
    const conversationKey = m365ConversationKey(parsed, rawConversationKey);
    const hasPriorAssistantReply = (parsed.context.messages || []).some(m => m.role === "assistant");
    const isNewConversation = !hasPriorAssistantReply;

    return TurnExecutionMetaDto.of({
      conversationKey,
      isNewConversation,
      traceContext: incoming.traceContext,
      traceId: incoming.headers.get("x-codex-trace-id") || undefined,
    });
  }

  protected buildTurnPrompt(parsed: CodexParsedRequest, meta: TurnExecutionMetaDto): string {
    const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
    const normalized = CodexPayloadNormalizer.normalize(rawPayload);
    const res = this.promptCompiler.compile({
      parsed,
      normalized,
      isNewConversation: meta.isNewConversation,
    });
    return res.finalPrompt;
  }

  protected translateResponse(rawReply: string, _parsed: CodexParsedRequest): ResponseTranslationResultDto {
    const result = this.outputTranslator.translate(rawReply);
    if (result.type === "tool_call" && result.tool_calls) {
      return ResponseTranslationResultDto.toolCalls(
        result.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }))
      );
    }
    if (result.type === "final_answer") {
      return ResponseTranslationResultDto.finalAnswer(result.content || "");
    }
    return ResponseTranslationResultDto.protocolError(
      result.parseDiagnostics?.terminalReason || "PROTOCOL_ERROR",
      result.parseDiagnostics?.warningMessage || "Lỗi giao thức",
      rawReply
    );
  }

  protected buildFormatRetryPrompt(code: string, message: string): string {
    return buildM365FormatRetryPrompt(code, message);
  }

  protected override async handleTitleGuardFastPath(
    parsed: CodexParsedRequest,
    prompt: string,
    _meta: TurnExecutionMetaDto,
    emit: (event: AdapterEvent) => void
  ): Promise<boolean> {
    if (this.options?.enableTitleGuard === false) return false;
    if (this.titleGuard.isTitleRequest(parsed, prompt)) {
      const title = this.titleGuard.generateTitleResponse(prompt);
      emit({ type: "text_delta", text: title });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      return true;
    }
    return false;
  }

  protected override cleanupSessionGuard(conversationKey?: string): void {
    if (conversationKey) {
      this.loopGuard.resetIteration(conversationKey);
    }
  }
}

export function createM365CopilotAdapter(options?: { enableTitleGuard?: boolean }): M365CopilotAdapter {
  return new M365CopilotAdapter(options);
}

export const m365CopilotAdapter = new M365CopilotAdapter();
