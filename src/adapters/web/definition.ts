import type { Page } from "playwright-core";
import type { IncomingMeta } from "../base";
import type { AdapterEvent, CodexParsedRequest, CodexUsage } from "../../types";
import type { LauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import type { NormalizedImageAttachment } from "./normalization/canonical-types";
import type { M365ProtocolErrorCode } from "./protocol/strict-response-parser";
import type { ToolValidationFailure } from "./tools/tool-validator";

export type WebLauncherProviderId =
  | "chatgpt"
  | "m365"
  | "gemini"
  | "google-ai-studio"
  | "qwen";

export type WebTurnFinalStatus = "completed" | "failed" | "aborted";

export interface WebConversationStateResolution {
  existingConversationId?: string;
  isNewConversation: boolean;
}

export interface WebEndTurnBindingResolution {
  connectorBound: boolean;
  conversationId?: string;
}

export interface WebConversationDriver {
  resolveThreadId?(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
  ): string | undefined;

  resolveConversationKey(context: {
    parsed: CodexParsedRequest;
    incoming: IncomingMeta;
    threadId?: string;
  }): string | undefined;

  resolveState?(context: {
    parsed: CodexParsedRequest;
    incoming: IncomingMeta;
    threadId?: string;
    conversationKey?: string;
    leaseConversationId?: string;
    launcherReused: boolean;
    hasPriorAssistantReply: boolean;
  }): WebConversationStateResolution;

  onConversationUpdated?(context: {
    threadId?: string;
    conversationKey?: string;
    conversationId?: string;
  }): string | undefined;

  resolveEndTurnBinding?(context: {
    finalStatus: WebTurnFinalStatus;
    activeConversationId?: string;
    conversationKey?: string;
  }): WebEndTurnBindingResolution;
}

export interface WebCapabilityPickerDriver {
  resolveReasoningEffort?(parsed: CodexParsedRequest): string | undefined;
}

export interface WebAttachmentDriver {
  extractAttachments?(context: {
    parsed: CodexParsedRequest;
    attempt: number;
  }): NormalizedImageAttachment[];
}

export interface WebBrowserTurnExecutionInput {
  page: Page | null;
  prompt: string;
  attempt: number;
  parsed: CodexParsedRequest;
  incoming: IncomingMeta;
  reasoningEffort?: string;
  conversationKey?: string;
  existingConversationId?: string;
  isNewConversation: boolean;
  attachments: NormalizedImageAttachment[];
  turnTraceId: string;
}

export interface WebBrowserTurnExecutionOutput {
  rawResponse: string;
  conversationId?: string;
}

export interface WebBrowserDriver {
  descriptorPath?: string;
  descriptorSubdirs?: string[];
  launcherProviderId: WebLauncherProviderId;
  connectorIdentity: string;
  resolveSurfaceId?: (
    descriptor: LauncherBrowserHostDescriptor,
    leaseSurfaceId?: string,
  ) => string | undefined;
  executeTurn(
    input: WebBrowserTurnExecutionInput,
  ): Promise<WebBrowserTurnExecutionOutput>;
}

export interface WebResponseDriver {
  sanitizeRawResponse?(raw: string): string;
  classifyValidationFailure?: (
    failure: ToolValidationFailure,
  ) => M365ProtocolErrorCode;
  tolerantNaturalTextFallback?: boolean;
  createCallId?: () => string;
  includeDetailedDoneEvent?: boolean;
  toolCallStopReason?: string;
  toolCallEndTurn?: boolean;
  computeUsage?(context: {
    initialPrompt: string;
    totalPromptChars: number;
    lastRaw: string;
  }): CodexUsage | undefined;
}

export interface WebProviderPolicies {
  /**
   * Hành vi khi có descriptorPath nhưng kết nối Launcher CDP thất bại:
   * - "fail-closed": ném lỗi ngay (mặc định cho ChatGPT, Qwen, Google AI Studio, M365).
   * - "fallback-local": ghi cảnh báo và chuyển sang LocalBrowserRuntime (Gemini).
   */
  launcherFailureMode?: "fail-closed" | "fallback-local";

  /**
   * Có quản lý lease start/end của Launcher ngay trong WebTurnEngine hay không
   * (mặc định true; false khi worker tự quản lý lease theo từng attempt như M365).
   */
  manageLauncherLeaseInEngine?: boolean;

  /**
   * Có đóng kết nối CDP (closeLauncherBrowserTurn) trong khối finally hay không (mặc định true).
   */
  closeLauncherConnectionOnEnd?: boolean;

  /**
   * Có phát sự kiện `emit({ type: "error", message })` khi xảy ra lỗi trong runTurn hay không.
   */
  emitErrorEventOnFailure?: boolean;

  /**
   * Tiền tố thông báo lỗi khi phát sự kiện error (nếu có).
   */
  errorMessagePrefix?: string;

  /**
   * Có ném lại (rethrow) lỗi sau khi xử lý trong catch hay không (mặc định true).
   */
  rethrowError?: boolean;

  /**
   * Số lần thử lại tối đa khi sai định dạng giao thức `<webResponse>` (mặc định 2).
   */
  maxFormatRetries?: number | (() => number);

  /**
   * Thông báo lỗi tùy chỉnh khi lượt bị hủy bởi abortSignal trong quá trình chạy.
   */
  abortedTurnMessage?: string;

  /**
   * Kiểm tra tin nhắn cuối cùng trong context đã là câu trả lời hoàn tất của assistant để ngắt sớm (M365).
   */
  enableEarlyExitOnFinalAnswer?: boolean;

  /**
   * Bật bộ bảo vệ chống lặp vô hạn công cụ (`conversationGuard` / `MAX_TOOL_ITERATIONS`).
   */
  enableToolLoopGuard?: boolean;

  /**
   * Cấu hình tạo traceId cho lượt tương tác.
   */
  traceIdOptions?: {
    byteLength?: number;
    encoding?: "base64url" | "hex";
  };
}

export interface WebProviderDefinition {
  /** Định danh chuẩn của adapter (vd: "gemini-web", "qwen-web", "google-ai-studio", "chatgpt-web", "m365-copilot") */
  readonly id: string;
  /** Tên hiển thị của trợ lý trong prompt compiler & retry loop (vd: "Gemini", "Qwen", "Google AI Studio", "ChatGPT", "M365") */
  readonly assistantName: string;
  /** Tiền tố log vận hành (vd: "gemini-adapter") */
  readonly logPrefix: string;
  /** Tin nhắn báo lỗi khi bị abort trước lúc bắt đầu lượt */
  readonly abortMessage?: string;
  /** Tuỳ chọn biên dịch prompt đặc thù nếu cần ghi đè */
  readonly compilePrompt?: (
    parsed: CodexParsedRequest,
    isNewConversation: boolean,
  ) => string;

  readonly conversation: WebConversationDriver;
  readonly capability?: WebCapabilityPickerDriver;
  readonly attachments?: WebAttachmentDriver;
  readonly browser: WebBrowserDriver;
  readonly response?: WebResponseDriver;
  readonly policies?: WebProviderPolicies;
}

export interface WebTurnExecutionContext {
  parsed: CodexParsedRequest;
  incoming: IncomingMeta;
  emit: (event: AdapterEvent) => void;
}
