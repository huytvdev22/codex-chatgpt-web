import type { ProviderAdapterFactory } from "../adapters/adapter-registry";
import { formatErrorResponse } from "../bridge";
import { readJsonRequestBody } from "../http-body";
import { GeminiSpeechService, type GeminiSpeechMethod } from "../services/gemini-speech-service";

/**
 * Controller xử lý các route tương thích Gemini TTS REST API:
 * `POST /v1beta/models/:model:generateContent` và `:streamGenerateContent`.
 */
export class GeminiSpeechController {
  constructor(
    private readonly speechService: GeminiSpeechService = new GeminiSpeechService(),
  ) {}

  public async handleSpeech(
    req: Request,
    modelId: string,
    method: GeminiSpeechMethod,
    adapterFactory?: ProviderAdapterFactory,
  ): Promise<Response> {
    let raw: unknown;
    try {
      raw = await readJsonRequestBody(req);
    } catch (error) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        error instanceof Error ? error.message : "Request body must be valid JSON",
      );
    }

    return await this.speechService.executeSpeech({
      req,
      modelId,
      method,
      raw,
      adapterFactory,
    });
  }
}

