import { randomUUID } from "node:crypto";
import { AdapterRegistry, type ProviderAdapterFactory } from "../adapters/adapter-registry";
import type { RawTurnImageInput } from "../adapters/base";
import { formatErrorResponse } from "../bridge";
import { ModelRegistry } from "../models/model-registry";
import { V2ConversationStore } from "./v2-conversation-store";

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
const MAX_RAW_IMAGES = 3;
const MAX_CONVERSATION_TOKEN_LENGTH = 256;

interface ParsedV2Request {
  requestedModel: string;
  providerId: string;
  prompt: string;
  reasoning?: string;
  images: RawTurnImageInput[];
  requestedConversationKey?: string;
  requestedConversationId?: string;
}

function normalizeOptionalIdentifier(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`'${fieldName}' must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_CONVERSATION_TOKEN_LENGTH) {
    throw new Error(`'${fieldName}' exceeds ${MAX_CONVERSATION_TOKEN_LENGTH} characters`);
  }
  return trimmed;
}

function normalizeReasoning(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const effort = (value as { effort?: unknown }).effort;
    if (effort === undefined || effort === null) return undefined;
    if (typeof effort === "string") {
      const trimmed = effort.trim();
      return trimmed || undefined;
    }
  }
  throw new Error("'reasoning' must be a string or { effort: string }");
}

function decodeDataUrlImage(dataUrl: string, name?: string): RawTurnImageInput {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Image string must be a base64 data:image/... URL");
  }
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported image MIME type '${mimeType}'`);
  }
  const cleanBase64 = match[2].replace(/\s+/g, "");
  const buffer = Buffer.from(cleanBase64, "base64");
  if (buffer.length === 0) {
    throw new Error("Image payload is empty");
  }
  return {
    ...(name ? { name } : {}),
    mimeType,
    dataUrl: `data:${mimeType};base64,${cleanBase64}`,
    buffer,
  };
}

function parseRawImages(rawImages: unknown): RawTurnImageInput[] {
  if (rawImages === undefined || rawImages === null) return [];
  if (!Array.isArray(rawImages)) {
    throw new Error("'images' must be an array");
  }
  if (rawImages.length > MAX_RAW_IMAGES) {
    throw new Error(`'images' supports at most ${MAX_RAW_IMAGES} items per turn`);
  }

  return rawImages.map((item, index) => {
    if (typeof item === "string") {
      return decodeDataUrlImage(item);
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`images[${index}] must be a data URL string or an image object`);
    }
    const obj = item as {
      dataUrl?: unknown;
      url?: unknown;
      base64?: unknown;
      mimeType?: unknown;
      name?: unknown;
      filename?: unknown;
    };
    const name = typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : typeof obj.filename === "string" && obj.filename.trim()
        ? obj.filename.trim()
        : undefined;

    if (typeof obj.dataUrl === "string") {
      return decodeDataUrlImage(obj.dataUrl, name);
    }
    if (typeof obj.url === "string") {
      return decodeDataUrlImage(obj.url, name);
    }
    if (typeof obj.base64 === "string" && typeof obj.mimeType === "string") {
      const mimeType = obj.mimeType.trim().toLowerCase();
      return decodeDataUrlImage(`data:${mimeType};base64,${obj.base64.trim()}`, name);
    }
    throw new Error(`images[${index}] requires 'dataUrl' (or 'base64' + 'mimeType')`);
  });
}

/**
 * Tầng nghiệp vụ cho `POST /v2/responses` (Raw Passthrough + Target Conversation):
 * chuyển thẳng `prompt` nguyên văn tới adapter, không đi qua prompt builder hoặc strict parser,
 * đồng thời duy trì ánh xạ `conversation_key <-> conversation_id` và khóa đồng thời 409.
 */
export class RawResponsesService {
  private readonly activeLocks = new Set<string>();

  constructor(
    private readonly modelRegistry: ModelRegistry = ModelRegistry.getInstance(),
    private readonly adapterRegistry: AdapterRegistry = AdapterRegistry.getInstance(),
    private readonly conversationStore: V2ConversationStore = new V2ConversationStore(),
  ) {}

  private validateAndParse(raw: unknown): { ok: true; parsed: ParsedV2Request } | { ok: false; message: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, message: "Request body must be a JSON object" };
    }
    const body = raw as Record<string, unknown>;

    if (body.stream !== undefined && body.stream !== false) {
      return {
        ok: false,
        message: "POST /v2/responses supports non-stream mode only (omit stream or set stream: false)",
      };
    }

    const access = this.modelRegistry.resolveProviderAccess(body.model);
    if (!access.ok) {
      return { ok: false, message: access.message };
    }
    const requestedModel = access.requestedModel;
    const provider = access.provider;

    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      return { ok: false, message: "Missing or invalid 'prompt' parameter (must be a non-empty string)" };
    }

    try {
      const reasoning = normalizeReasoning(body.reasoning);
      const images = parseRawImages(body.images);
      const requestedConversationKey = normalizeOptionalIdentifier(body.conversation_key, "conversation_key");
      const requestedConversationId = normalizeOptionalIdentifier(body.conversation_id, "conversation_id");
      return {
        ok: true,
        parsed: {
          requestedModel,
          providerId: provider.id,
          // Giữ nguyên văn từng ký tự của prompt khi forward sang Web UI.
          prompt: body.prompt,
          reasoning,
          images,
          requestedConversationKey,
          requestedConversationId,
        },
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveConversationTarget(parsed: ParsedV2Request):
    | { ok: true; conversationKey: string; targetConversationId?: string }
    | { ok: false; message: string } {
    const { providerId, requestedConversationKey, requestedConversationId } = parsed;

    if (requestedConversationKey) {
      const stored = this.conversationStore.get(providerId, requestedConversationKey);
      if (requestedConversationId && stored?.conversationId && stored.conversationId !== requestedConversationId) {
        return {
          ok: false,
          message: `conversation_key '${requestedConversationKey}' is already bound to conversation_id '${stored.conversationId}'`,
        };
      }
      return {
        ok: true,
        conversationKey: requestedConversationKey,
        targetConversationId: requestedConversationId ?? stored?.conversationId,
      };
    }

    if (requestedConversationId) {
      const existing = this.conversationStore.findByConversationId(providerId, requestedConversationId);
      return {
        ok: true,
        conversationKey: existing?.conversationKey ?? `id:${requestedConversationId}`,
        targetConversationId: requestedConversationId,
      };
    }

    return {
      ok: true,
      conversationKey: randomUUID(),
      targetConversationId: undefined,
    };
  }

  private acquireConversationLocks(
    providerId: string,
    conversationKey: string,
    targetConversationId?: string,
  ): string[] | null {
    const keys = [`key:${providerId}:${conversationKey}`];
    if (targetConversationId) {
      keys.push(`id:${providerId}:${targetConversationId}`);
    }
    if (keys.some(key => this.activeLocks.has(key))) {
      return null;
    }
    for (const key of keys) {
      this.activeLocks.add(key);
    }
    return keys;
  }

  private releaseConversationLocks(keys: string[]): void {
    for (const key of keys) {
      this.activeLocks.delete(key);
    }
  }

  /**
   * Thực thi một lượt `POST /v2/responses` hoàn chỉnh và trả về JSON non-stream.
   */
  public async executeRawTurn(params: {
    req: Request;
    raw: unknown;
    adapterFactory?: ProviderAdapterFactory;
  }): Promise<Response> {
    const validated = this.validateAndParse(params.raw);
    if (!validated.ok) {
      return formatErrorResponse(400, "invalid_request_error", validated.message);
    }

    const { parsed } = validated;
    const target = this.resolveConversationTarget(parsed);
    if (!target.ok) {
      return formatErrorResponse(409, "conflict_error", target.message);
    }

    const lockKeys = this.acquireConversationLocks(
      parsed.providerId,
      target.conversationKey,
      target.targetConversationId,
    );
    if (!lockKeys) {
      return formatErrorResponse(
        409,
        "conflict_error",
        `Another /v2/responses turn is already running for target conversation '${target.targetConversationId ?? target.conversationKey}'`,
      );
    }

    const abort = new AbortController();
    if (params.req.signal.aborted) abort.abort();
    else params.req.signal.addEventListener("abort", () => abort.abort(), { once: true });

    try {
      const adapter = params.adapterFactory
        ? params.adapterFactory()
        : this.adapterRegistry.createAdapter(parsed.providerId);
      if (typeof adapter.runRawTurn !== "function") {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `Provider '${parsed.providerId}' does not support /v2/responses raw turn mode`,
        );
      }

      const result = await adapter.runRawTurn(
        {
          modelId: parsed.requestedModel,
          prompt: parsed.prompt,
          reasoning: parsed.reasoning,
          images: parsed.images,
          conversationKey: target.conversationKey,
          existingConversationId: target.targetConversationId,
        },
        {
          headers: params.req.headers,
          abortSignal: abort.signal,
        },
      );

      const resolvedConversationId = result.conversationId ?? target.targetConversationId;
      this.conversationStore.upsert({
        provider: parsed.providerId,
        conversationKey: target.conversationKey,
        conversationId: resolvedConversationId,
        model: parsed.requestedModel,
      });

      return Response.json({
        id: `resp_v2_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "v2.response",
        model: parsed.requestedModel,
        provider: parsed.providerId,
        conversation_key: target.conversationKey,
        conversation_id: resolvedConversationId ?? null,
        output_text: result.outputText,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (abort.signal.aborted) {
        return formatErrorResponse(499, "request_aborted", message || "Request aborted by client");
      }
      return formatErrorResponse(502, "adapter_error", message);
    } finally {
      this.releaseConversationLocks(lockKeys);
    }
  }
}

