import type { ProviderLimitCheckResult } from "../limits/types";
import type { DiscoveredModelEntry } from "../models/types";
import type { AdapterEvent, CodexParsedRequest } from "../types";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
  abortSignal?: AbortSignal;
}

export interface RawTurnImageInput {
  name?: string;
  mimeType: string;
  dataUrl: string;
  buffer: Buffer;
}

export interface RawTurnRequest {
  modelId: string;
  prompt: string;
  reasoning?: string;
  images?: RawTurnImageInput[];
  conversationKey?: string;
  existingConversationId?: string;
}

export interface RawTurnResult {
  outputText: string;
  conversationId?: string;
}

export interface SpeechSpeakerInput {
  speaker: string;
  voiceName: string;
}

export interface SpeechTurnRequest {
  modelId: string;
  text: string;
  temperature?: number;
  speakers: SpeechSpeakerInput[];
}

export interface SpeechTurnResult {
  audioBase64: string;
  mimeType: string;
}

export type ImageAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";

export interface ImageTurnRequest {
  modelId: string;
  reasoning?: string;
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  images?: RawTurnImageInput[];
  outputFormat?: "png" | "jpeg" | "webp";
  conversationKey?: string;
  existingConversationId?: string;
  conversationUrl?: string;
}

export interface ImageTurnResult {
  imageBase64: string;
  mimeType: string;
  revisedPrompt?: string;
  conversationId?: string;
  conversationUrl?: string;
}

export interface UsageLimitCheckRequest {
  profileId?: string;
}

export interface ProviderAdapter {
  name: string;
  runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
  runRawTurn?(
    request: RawTurnRequest,
    incoming: IncomingMeta,
  ): Promise<RawTurnResult>;
  runSpeechTurn?(
    request: SpeechTurnRequest,
    incoming: IncomingMeta,
  ): Promise<SpeechTurnResult>;
  runImageTurn?(
    request: ImageTurnRequest,
    incoming: IncomingMeta,
  ): Promise<ImageTurnResult>;
  discoverModels?(incoming?: IncomingMeta): Promise<DiscoveredModelEntry[]>;
  checkUsageLimit?(
    request?: UsageLimitCheckRequest,
    incoming?: IncomingMeta,
  ): Promise<ProviderLimitCheckResult>;
}

/**
 * Kiểm tra xem danh sách tin nhắn ngữ cảnh có thực sự chứa phản hồi có nội dung từ trợ lý (assistant) hay chưa.
 * Loại trừ hoàn toàn các placeholder rỗng ({ content: [] }), tin nhắn rỗng (""), hoặc thinking tạm thời.
 */
export function hasActualPriorAssistantReply(messages?: Array<any>): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  return messages.some((m) => {
    if (!m || m.role !== "assistant") return false;
    if (typeof m.content === "string") return m.content.trim().length > 0;
    if (Array.isArray(m.content)) {
      return m.content.some((p: any) => {
        if (!p) return false;
        if ((p.type === "text" || p.type === "output_text") && typeof p.text === "string" && p.text.trim().length > 0) {
          return true;
        }
        if (p.type === "toolCall") return true;
        return false;
      });
    }
    return false;
  });
}
