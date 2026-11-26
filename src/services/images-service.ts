import { AdapterRegistry, type ProviderAdapterFactory } from "../adapters/adapter-registry";
import type { ImageAspectRatio, RawTurnImageInput } from "../adapters/base";
import {
  normalizeGeminiConversationId,
  normalizeGeminiConversationUrl,
  parseGeminiConversationId,
} from "../adapters/gemini/conversation-url";
import { formatErrorResponse } from "../bridge";
import { readCodexConfiguredModel } from "../codex-integration-document";
import { ModelRegistry } from "../models/model-registry";
import type { ResponsesService } from "./responses-service";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const IMAGE_CONVERSATION_TTL_MS = 60 * 60_000;
const MAX_IMAGE_CONVERSATIONS = 256;
const SUPPORTED_ASPECT_RATIOS: ReadonlyArray<{ label: ImageAspectRatio; value: number }> = [
  { label: "1:1", value: 1 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
];

export interface ParsedImageRequest {
  prompt: string;
  requestedModel: string;
  size?: string;
  aspectRatio?: ImageAspectRatio;
  outputFormat?: "png" | "jpeg" | "webp";
  images?: RawTurnImageInput[];
  conversationId?: string;
  conversationUrl?: string;
}

interface ParsedTurnMetadataHeader {
  threadId?: string;
  turnId?: string;
  model?: string;
  reasoningEffort?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const CODEX_OPENAI_FIXED_SIZES = new Set([
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
]);

function extractExplicitPromptAspectRatio(
  prompt?: string,
): ImageAspectRatio | undefined {
  const cleanPrompt = typeof prompt === "string" ? prompt : "";
  if (!cleanPrompt) return undefined;

  const contextualMatch =
    /(?:aspect\s*ratio|ratio|tỉ\s*lệ|tỷ\s*lệ|khung\s*hình)\s*(?:is|of|:|=|là)?\s*(16:9|9:16|4:3|3:4|1:1)\b/i.exec(
      cleanPrompt,
    );
  if (contextualMatch) {
    return contextualMatch[1] as ImageAspectRatio;
  }

  const standaloneMatch = /(?:^|[\s(,;\[])(16:9|9:16|4:3|3:4|1:1)(?=$|[\s),.;\]!?])/i.exec(
    cleanPrompt,
  );
  if (standaloneMatch) {
    return standaloneMatch[1] as ImageAspectRatio;
  }

  return undefined;
}

/**
 * Ánh xạ `size` (`WIDTHxHEIGHT`) hoặc mẫu tỉ lệ tường minh trong `prompt`
 * về tỉ lệ khung hình chuẩn mà Gemini Web UI hỗ trợ.
 * Khi `prompt` ghi sẵn tỉ lệ tường minh và `size` là một trong các mức mặc định/cố định
 * của OpenAI `image_gen` (`auto`, `1024x1024`, `1536x1024`, `1024x1536`), ưu tiên tỉ lệ từ `prompt`.
 */
export function resolveRequestedAspectRatio(
  size?: string,
  prompt?: string,
): ImageAspectRatio | undefined {
  const promptRatio = extractExplicitPromptAspectRatio(prompt);
  const cleanSize = typeof size === "string" ? size.trim().toLowerCase() : "";

  if (promptRatio && (!cleanSize || CODEX_OPENAI_FIXED_SIZES.has(cleanSize))) {
    return promptRatio;
  }

  if (cleanSize && cleanSize !== "auto") {
    const dimMatch = /^([1-9]\d*)x([1-9]\d*)$/.exec(cleanSize);
    if (dimMatch) {
      const width = Number(dimMatch[1]);
      const height = Number(dimMatch[2]);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        const targetRatio = width / height;
        let best = SUPPORTED_ASPECT_RATIOS[0]!;
        let minDiff = Math.abs(targetRatio - best.value);
        for (const candidate of SUPPORTED_ASPECT_RATIOS.slice(1)) {
          const diff = Math.abs(targetRatio - candidate.value);
          if (diff < minDiff) {
            minDiff = diff;
            best = candidate;
          }
        }
        return best.label;
      }
    }
  }

  return promptRatio;
}

function parseTurnMetadataHeader(headers: Headers): ParsedTurnMetadataHeader {
  const rawHeader = headers.get("x-codex-turn-metadata");
  if (!rawHeader) return {};
  try {
    const parsed = asRecord(JSON.parse(rawHeader));
    if (!parsed) return {};
    const threadId =
      typeof parsed.thread_id === "string" && parsed.thread_id.trim()
        ? parsed.thread_id.trim()
        : typeof parsed.session_id === "string" && parsed.session_id.trim()
          ? parsed.session_id.trim()
          : undefined;
    const turnId =
      typeof parsed.turn_id === "string" && parsed.turn_id.trim()
        ? parsed.turn_id.trim()
        : undefined;
    const model =
      typeof parsed.model === "string" && parsed.model.trim()
        ? parsed.model.trim()
        : undefined;
    const reasoningEffort =
      typeof parsed.reasoning_effort === "string" && parsed.reasoning_effort.trim()
        ? parsed.reasoning_effort.trim()
        : undefined;
    return { threadId, turnId, model, reasoningEffort };
  } catch {
    return {};
  }
}

function decodeDataUrlImage(dataUrl: string, index: number): RawTurnImageInput {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    dataUrl.trim(),
  );
  if (!match) {
    throw new Error(
      `images[${index}].image_url must be a base64 data:image/* URL`,
    );
  }
  const mimeType = match[1]!.toLowerCase();
  const cleanBase64 = match[2]!.replace(/\s+/g, "");
  const buffer = Buffer.from(cleanBase64, "base64");
  if (buffer.length === 0) {
    throw new Error(`images[${index}] decoded to empty image data`);
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`images[${index}] exceeds maximum size of 50MB`);
  }
  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return {
    name: `image-${index + 1}.${ext}`,
    mimeType,
    dataUrl: `data:${mimeType};base64,${cleanBase64}`,
    buffer,
  };
}

function parseCommonImageFields(
  fields: Record<string, unknown>,
): { ok: true; data: Omit<ParsedImageRequest, "images"> } | { ok: false; message: string } {
  const prompt = typeof fields.prompt === "string" ? fields.prompt.trim() : "";
  if (!prompt) {
    return { ok: false, message: "'prompt' must be a non-empty string" };
  }

  const gifVal = fields.gif;
  const hasGifOption =
    gifVal !== undefined &&
    gifVal !== null &&
    gifVal !== false &&
    gifVal !== "false" &&
    gifVal !== "";
  const rawOutputFormat =
    typeof fields.output_format === "string"
      ? fields.output_format.trim().toLowerCase()
      : "";
  if (hasGifOption || rawOutputFormat === "gif") {
    return {
      ok: false,
      message: "Gemini Web image generation does not support animated GIF output.",
    };
  }

  const rawBackground =
    typeof fields.background === "string"
      ? fields.background.trim().toLowerCase()
      : "";
  const rawTransparent = fields.transparent_background;
  if (
    rawBackground === "transparent" ||
    rawTransparent === true ||
    rawTransparent === "true"
  ) {
    return {
      ok: false,
      message:
        "Gemini Web image generation does not support native transparent backgrounds (alpha channel).",
    };
  }

  let outputFormat: "png" | "jpeg" | "webp" | undefined;
  if (rawOutputFormat) {
    if (
      rawOutputFormat === "png" ||
      rawOutputFormat === "jpeg" ||
      rawOutputFormat === "webp"
    ) {
      outputFormat = rawOutputFormat;
    } else if (rawOutputFormat === "jpg") {
      outputFormat = "jpeg";
    } else {
      return {
        ok: false,
        message: `Unsupported output_format '${rawOutputFormat}'. Supported values: png, jpeg, webp.`,
      };
    }
  }

  const requestedModel =
    typeof fields.model === "string" && fields.model.trim()
      ? fields.model.trim()
      : "gpt-image-2";
  const size = typeof fields.size === "string" ? fields.size.trim() : undefined;
  const aspectRatio = resolveRequestedAspectRatio(size, prompt);
  const conversationUrl = normalizeGeminiConversationUrl(fields.conversation_url);
  const conversationId =
    normalizeGeminiConversationId(fields.conversation_id) ||
    (conversationUrl ? parseGeminiConversationId(conversationUrl) : undefined);

  return {
    ok: true,
    data: {
      prompt,
      requestedModel,
      ...(size ? { size } : {}),
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(outputFormat ? { outputFormat } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(conversationUrl ? { conversationUrl } : {}),
    },
  };
}

/**
 * Tầng nghiệp vụ cho các endpoint OpenAI Images API tương thích Codex:
 * `POST /v1/images/generations` và `POST /v1/images/edits`.
 * Điều phối kiểm tra fail-fast, khóa phạm vi provider `gemini` đang hoạt động,
 * và gọi `GeminiAdapter.runImageTurn` qua tab Launcher độc lập.
 */
export class ImagesService {
  private readonly imageConversationsByThread = new Map<
    string,
    { conversationId: string; recordedAt: number }
  >();

  constructor(
    private readonly responsesService: ResponsesService,
    private readonly modelRegistry: ModelRegistry = ModelRegistry.getInstance(),
    private readonly adapterRegistry: AdapterRegistry = AdapterRegistry.getInstance(),
    private readonly readConfiguredModel: () => string | undefined = readCodexConfiguredModel,
  ) {}

  private getThreadImageConversation(threadId?: string): string | undefined {
    const key = threadId?.trim();
    if (!key) return undefined;
    const entry = this.imageConversationsByThread.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.recordedAt > IMAGE_CONVERSATION_TTL_MS) {
      this.imageConversationsByThread.delete(key);
      return undefined;
    }
    return entry.conversationId;
  }

  private rememberThreadImageConversation(
    threadId: string | undefined,
    conversationId: string | undefined,
  ): void {
    const key = threadId?.trim();
    const convId = conversationId?.trim();
    if (!key || !convId) return;
    this.imageConversationsByThread.delete(key);
    this.imageConversationsByThread.set(key, {
      conversationId: convId,
      recordedAt: Date.now(),
    });
    while (this.imageConversationsByThread.size > MAX_IMAGE_CONVERSATIONS) {
      const oldest = this.imageConversationsByThread.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.imageConversationsByThread.delete(oldest);
    }
  }

  public validateGenerationJson(
    raw: unknown,
  ): { ok: true; parsed: ParsedImageRequest } | { ok: false; message: string } {
    const body = asRecord(raw);
    if (!body) {
      return { ok: false, message: "Request body must be a JSON object" };
    }
    const common = parseCommonImageFields(body);
    if (!common.ok) return common;
    return { ok: true, parsed: common.data };
  }

  public validateEditJson(
    raw: unknown,
  ): { ok: true; parsed: ParsedImageRequest } | { ok: false; message: string } {
    const body = asRecord(raw);
    if (!body) {
      return { ok: false, message: "Request body must be a JSON object" };
    }
    if (body.mask !== undefined && body.mask !== null) {
      return {
        ok: false,
        message: "Gemini Web image editing does not support explicit mask bitmaps.",
      };
    }

    const common = parseCommonImageFields(body);
    if (!common.ok) return common;

    const rawImages = Array.isArray(body.images)
      ? body.images
      : body.image !== undefined
        ? [body.image]
        : [];
    if (rawImages.length === 0) {
      return {
        ok: false,
        message: "/v1/images/edits requires at least one source image in 'images' or 'image'.",
      };
    }

    const images: RawTurnImageInput[] = [];
    try {
      for (let idx = 0; idx < rawImages.length; idx += 1) {
        const entry = rawImages[idx];
        if (typeof entry === "string") {
          images.push(decodeDataUrlImage(entry, idx));
          continue;
        }
        const entryObj = asRecord(entry);
        if (!entryObj) {
          throw new Error(`images[${idx}] must be an image object or data URL string`);
        }
        if (typeof entryObj.image_url === "string" && entryObj.image_url.trim()) {
          images.push(decodeDataUrlImage(entryObj.image_url, idx));
        } else if (typeof entryObj.file_id === "string" && entryObj.file_id.trim()) {
          throw new Error(
            `images[${idx}].file_id is not supported; pass a base64 data URL in image_url or multipart file.`,
          );
        } else {
          throw new Error(`images[${idx}] requires image_url`);
        }
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      ok: true,
      parsed: {
        ...common.data,
        images,
      },
    };
  }

  public async parseEditFormData(
    form: FormData,
  ): Promise<{ ok: true; parsed: ParsedImageRequest } | { ok: false; message: string }> {
    if (form.get("mask") !== null) {
      return {
        ok: false,
        message: "Gemini Web image editing does not support explicit mask bitmaps.",
      };
    }

    const fields: Record<string, unknown> = {};
    for (const key of [
      "prompt",
      "model",
      "size",
      "background",
      "transparent_background",
      "output_format",
      "gif",
      "conversation_id",
      "conversation_url",
    ]) {
      const value = form.get(key);
      if (typeof value === "string") {
        fields[key] = value;
      }
    }

    const common = parseCommonImageFields(fields);
    if (!common.ok) return common;

    const rawEntries = [
      ...form.getAll("image"),
      ...form.getAll("image[]"),
      ...form.getAll("images"),
    ];
    if (rawEntries.length === 0) {
      return {
        ok: false,
        message: "/v1/images/edits multipart form requires at least one 'image' file.",
      };
    }

    const images: RawTurnImageInput[] = [];
    for (let idx = 0; idx < rawEntries.length; idx += 1) {
      const entry = rawEntries[idx];
      if (typeof entry === "string") {
        try {
          images.push(decodeDataUrlImage(entry, idx));
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
        continue;
      }
      if (!(entry instanceof Blob)) {
        return { ok: false, message: `image[${idx}] must be a file blob` };
      }
      if (entry.size <= 0) {
        return { ok: false, message: `image[${idx}] is empty` };
      }
      if (entry.size > MAX_IMAGE_BYTES) {
        return { ok: false, message: `image[${idx}] exceeds maximum size of 50MB` };
      }
      const buffer = Buffer.from(await entry.arrayBuffer());
      const mimeType =
        entry.type && entry.type.startsWith("image/")
          ? entry.type.toLowerCase()
          : "image/png";
      const fileName =
        entry instanceof File && entry.name
          ? entry.name
          : `image-${idx + 1}.${mimeType.split("/")[1] || "png"}`;
      images.push({
        name: fileName,
        mimeType,
        dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
        buffer,
      });
    }

    return {
      ok: true,
      parsed: {
        ...common.data,
        images,
      },
    };
  }

  /**
   * Xác minh request ảnh được phép chạy trên Gemini Web:
   * chỉ cho phép khi request chỉ định rõ model `gemini/*` hoặc active turn / cấu hình Codex đang dùng provider `gemini`.
   */
  public resolveGeminiImageTarget(
    requestedImageModel: string,
    headers: Headers,
  ):
    | { ok: true; geminiModelId: string; reasoning?: string }
    | { ok: false; message: string } {
    const headerMeta = parseTurnMetadataHeader(headers);

    const directAccess = this.modelRegistry.resolveProviderAccess(requestedImageModel);
    if (directAccess.ok && directAccess.provider.id === "gemini") {
      return {
        ok: true,
        geminiModelId: directAccess.requestedModel,
        ...(headerMeta.reasoningEffort ? { reasoning: headerMeta.reasoningEffort } : {}),
      };
    }

    const byThread = this.responsesService.resolveThreadTurnContext(headerMeta.threadId);
    if (byThread) {
      if (byThread.providerId !== "gemini") {
        return {
          ok: false,
          message: `Image generation is only supported when chatting with a Gemini Web model (active provider: '${byThread.providerId}').`,
        };
      }
      return {
        ok: true,
        geminiModelId: byThread.modelId,
        reasoning: headerMeta.reasoningEffort || byThread.reasoning,
      };
    }

    if (headerMeta.model) {
      const headerAccess = this.modelRegistry.resolveProviderAccess(headerMeta.model);
      if (!headerAccess.ok) {
        return {
          ok: false,
          message: `Image generation is only supported with an enabled Gemini Web model (${headerAccess.message}).`,
        };
      }
      if (headerAccess.provider.id !== "gemini") {
        return {
          ok: false,
          message: `Image generation is only supported when chatting with a Gemini Web model (active provider: '${headerAccess.provider.id}').`,
        };
      }
      return {
        ok: true,
        geminiModelId: headerAccess.requestedModel,
        ...(headerMeta.reasoningEffort ? { reasoning: headerMeta.reasoningEffort } : {}),
      };
    }

    const activeTurn = this.responsesService.resolveActiveTurnContext({
      threadId: headerMeta.threadId,
      turnId: headerMeta.turnId,
    });
    if (activeTurn) {
      if (activeTurn.providerId !== "gemini") {
        return {
          ok: false,
          message: `Image generation is only supported when chatting with a Gemini Web model (active provider: '${activeTurn.providerId}').`,
        };
      }
      return {
        ok: true,
        geminiModelId: activeTurn.modelId,
        reasoning: headerMeta.reasoningEffort || activeTurn.reasoning,
      };
    }

    const fallbackModel = this.readConfiguredModel();
    if (!fallbackModel) {
      return {
        ok: false,
        message:
          "Image generation requires an active Gemini Web chat model; no active Gemini session or configured model was found.",
      };
    }

    const fallbackAccess = this.modelRegistry.resolveProviderAccess(fallbackModel);
    if (!fallbackAccess.ok) {
      return {
        ok: false,
        message: `Image generation is only supported with an enabled Gemini Web model (${fallbackAccess.message}).`,
      };
    }
    if (fallbackAccess.provider.id !== "gemini") {
      return {
        ok: false,
        message: `Image generation is only supported when chatting with a Gemini Web model (active provider: '${fallbackAccess.provider.id}').`,
      };
    }

    return {
      ok: true,
      geminiModelId: fallbackAccess.requestedModel,
      ...(headerMeta.reasoningEffort ? { reasoning: headerMeta.reasoningEffort } : {}),
    };
  }

  public async executeImageTurn(params: {
    req: Request;
    parsed: ParsedImageRequest;
    adapterFactory?: ProviderAdapterFactory;
  }): Promise<Response> {
    const target = this.resolveGeminiImageTarget(
      params.parsed.requestedModel,
      params.req.headers,
    );
    if (!target.ok) {
      return formatErrorResponse(400, "invalid_request_error", target.message);
    }

    const abort = new AbortController();
    if (params.req.signal.aborted) abort.abort();
    else {
      params.req.signal.addEventListener("abort", () => abort.abort(), {
        once: true,
      });
    }

    const headerMeta = parseTurnMetadataHeader(params.req.headers);
    const existingConversationId =
      params.parsed.conversationId ||
      this.getThreadImageConversation(headerMeta.threadId);
    const existingConversationUrl = params.parsed.conversationUrl;
    const conversationKey = headerMeta.threadId
      ? `image:${headerMeta.threadId}`
      : existingConversationId
        ? `image-conv:${existingConversationId}`
        : undefined;

    try {
      const adapter = params.adapterFactory
        ? params.adapterFactory()
        : this.adapterRegistry.createAdapter("gemini");
      if (typeof adapter.runImageTurn !== "function") {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          "Configured 'gemini' adapter does not support image generation",
        );
      }

      const result = await adapter.runImageTurn(
        {
          modelId: target.geminiModelId,
          ...(target.reasoning ? { reasoning: target.reasoning } : {}),
          prompt: params.parsed.prompt,
          ...(params.parsed.aspectRatio
            ? { aspectRatio: params.parsed.aspectRatio }
            : {}),
          ...(params.parsed.images ? { images: params.parsed.images } : {}),
          outputFormat: params.parsed.outputFormat ?? "png",
          ...(conversationKey ? { conversationKey } : {}),
          ...(existingConversationId ? { existingConversationId } : {}),
          ...(existingConversationUrl
            ? { conversationUrl: existingConversationUrl }
            : {}),
        },
        {
          headers: params.req.headers,
          abortSignal: abort.signal,
        },
      );

      this.rememberThreadImageConversation(
        headerMeta.threadId,
        result.conversationId || existingConversationId,
      );

      const outputFormat =
        result.mimeType === "image/jpeg"
          ? "jpeg"
          : result.mimeType === "image/webp"
            ? "webp"
            : "png";

      return Response.json({
        created: Math.floor(Date.now() / 1000),
        ...(result.conversationId ? { conversation_id: result.conversationId } : {}),
        ...(result.conversationUrl
          ? { conversation_url: result.conversationUrl }
          : {}),
        data: [
          {
            b64_json: result.imageBase64,
            revised_prompt: result.revisedPrompt ?? params.parsed.prompt,
          },
        ],
        output_format: outputFormat,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        return formatErrorResponse(
          499,
          "request_aborted",
          message || "Image request aborted by client",
        );
      }
      if (error instanceof Error && error.name === "GeminiImageRefusalError") {
        return formatErrorResponse(422, "invalid_request_error", message);
      }
      return formatErrorResponse(502, "adapter_error", message);
    }
  }
}
