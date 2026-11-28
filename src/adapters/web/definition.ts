import type { Page } from "playwright-core";
import type { IncomingMeta } from "../base";
import type { ProviderLimitCheckResult } from "../../limits/types";
import type { DiscoveredModelEntry } from "../../models/types";
import type { AdapterEvent, CodexParsedRequest, CodexUsage } from "../../types";
import type { ProviderReportedTokens } from "../../usage/types";
import type { LauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import type {
  NormalizedCodexRequest,
  NormalizedImageAttachment,
} from "./normalization/canonical-types";
import type { WebProtocolErrorCode } from "./protocol/strict-response-parser";
import type { ToolValidationFailure } from "./tools/tool-validator";

/** Mã định danh của Web provider đăng ký trong Launcher BrowserHost (`BrowserProviderRegistry`). */
export type WebLauncherProviderId = string;

export type WebTurnFinalStatus = "completed" | "failed" | "aborted";

export interface WebConversationStateResolution {
  existingConversationId?: string;
  isNewConversation: boolean;
}

export interface WebEndTurnBindingResolution {
  connectorBound: boolean;
  conversationId?: string;
  retain?: boolean;
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
    turnTraceId?: string;
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
    parsed?: CodexParsedRequest;
    hasPriorAssistantReply?: boolean;
    hasToolResults?: boolean;
  }): WebEndTurnBindingResolution;
}

export interface WebCapabilityPickerDriver {
  resolveReasoningEffort?(parsed: CodexParsedRequest): string | undefined;
}

export type WebAttachmentAttemptKind =
  | "initial"
  | "pre_submit"
  | "transport"
  | "failover"
  | "format"
  | "tool_describe"
  | "tool_recovery";

export interface WebAttachmentExtractContext {
  parsed: CodexParsedRequest;
  attempt: number;
  normalized?: NormalizedCodexRequest;
  isNewConversation?: boolean;
  isPostSubmitRetry?: boolean;
  originalMessageSubmitted?: boolean;
  retryKind?: WebAttachmentAttemptKind;
}

export interface WebAttachmentDriver {
  /** Số lượng ảnh tối đa adapter hỗ trợ trong một lượt (mặc định 3). */
  maxInputImages?: number;
  extractAttachments?(
    context: WebAttachmentExtractContext,
  ): NormalizedImageAttachment[];
}

export interface WebBrowserTurnExecutionInput {
  page: Page;
  prompt: string;
  attempt: number;
  parsed: CodexParsedRequest;
  incoming: IncomingMeta;
  reasoningEffort?: string;
  conversationKey?: string;
  existingConversationId?: string;
  launcherReused: boolean;
  isNewConversation: boolean;
  retain?: boolean;
  attachments: NormalizedImageAttachment[];
  turnTraceId: string;
  /** Bật đọc snapshot văn bản tăng dần khi đang sinh (opt-in, mặc định false). */
  streamIncremental?: boolean;
  /** Callback nhận delta văn bản tăng dần khi streamIncremental = true. */
  onChunk?: (text: string) => void;
  /** Callback nhận toàn bộ snapshot văn bản mới nhất khi streamIncremental = true. */
  onTextSnapshot?: (snapshot: string) => void;
  /**
   * Gia hạn quyền sử dụng Launcher surface cho các lượt browser kéo dài.
   * Provider chỉ gọi callback này, không tự gửi lifecycle activity tới Launcher.
   */
  heartbeat?: () => Promise<void>;
}

export interface WebBrowserTurnExecutionOutput {
  rawResponse: string;
  conversationId?: string;
  providerReportedTokens?: ProviderReportedTokens;
}

export interface WebBrowserDriver {
  descriptorPath?: string;
  descriptorSubdirs?: string[];
  launcherProviderId: WebLauncherProviderId;
  connectorIdentity?: string;
  resolveSurfaceId?: (
    descriptor: LauncherBrowserHostDescriptor,
    leaseSurfaceId?: string,
  ) => string | undefined;
  resolveInitialUrl?: (context: {
    modelId: string;
    existingConversationId?: string;
  }) => string | undefined;
  executeTurn(
    input: WebBrowserTurnExecutionInput,
  ): Promise<WebBrowserTurnExecutionOutput>;
  discoverModels?(context: {
    page: Page;
    abortSignal?: AbortSignal;
  }): Promise<DiscoveredModelEntry[]>;
  usageLimitUrl?: string;
  checkUsageLimit?(context: {
    page: Page;
    abortSignal?: AbortSignal;
  }): Promise<ProviderLimitCheckResult>;
}

export interface WebResponseDriver {
  sanitizeRawResponse?(raw: string): string;
  classifyValidationFailure?: (
    failure: ToolValidationFailure,
  ) => WebProtocolErrorCode;
  tolerantNaturalTextFallback?: boolean;
  createCallId?: () => string;
  includeDetailedDoneEvent?: boolean;
  toolCallStopReason?: string;
  toolCallEndTurn?: boolean;
  computeUsage?(context: {
    initialPrompt: string;
    totalPromptChars: number;
    lastRaw: string;
    prompts?: readonly string[];
    rawOutputs?: readonly string[];
    providerReportedTokens?: ProviderReportedTokens;
  }): CodexUsage | undefined;
}

export interface WebProviderPolicies {
  /**
   * Hành vi khi có descriptorPath nhưng kết nối Launcher CDP thất bại:
   * - "fail-closed": ném lỗi ngay (mặc định cho ChatGPT, M365).
   * - "fallback-local": ghi cảnh báo và chuyển sang LocalBrowserRuntime.
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
   * Ngưỡng độ dài tối đa của prompt sau khi biên dịch trước khi cắt tỉa (mặc định 95_000).
   */
  maxPromptChars?: number;

  /**
   * Cấu hình tạo traceId cho lượt tương tác.
   */
  traceIdOptions?: {
    byteLength?: number;
    encoding?: "base64url" | "hex";
  };
}

export interface WebProviderDefinition {
  /** Định danh chuẩn của adapter (vd: "chatgpt-web", "m365-copilot") */
  readonly id: string;
  /** Tên hiển thị của trợ lý trong prompt compiler & retry loop (vd: "ChatGPT", "M365") */
  readonly assistantName: string;
  /** Tiền tố log vận hành (vd: "m365-adapter") */
  readonly logPrefix: string;
  /** Tin nhắn báo lỗi khi bị abort trước lúc bắt đầu lượt */
  readonly abortMessage?: string;
  /** Tuỳ chọn biên dịch prompt đặc thù nếu cần ghi đè */
  readonly compilePrompt?: (
    parsed: CodexParsedRequest,
    isNewConversation: boolean,
    normalized?: NormalizedCodexRequest,
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
