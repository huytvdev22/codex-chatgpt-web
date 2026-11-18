import { AdapterRegistry, type ProviderAdapterFactory } from "../adapters/adapter-registry";
import type { SpeechSpeakerInput } from "../adapters/base";
import { formatErrorResponse } from "../bridge";

export type GeminiSpeechMethod = "generateContent" | "streamGenerateContent";

interface ParsedGeminiSpeechRequest {
  modelId: string;
  text: string;
  temperature?: number;
  speakers: SpeechSpeakerInput[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractContentsText(contents: unknown): string {
  if (!Array.isArray(contents) || contents.length === 0) {
    throw new Error("Missing or invalid 'contents' array");
  }
  const chunks: string[] = [];
  for (const item of contents) {
    const contentObj = asRecord(item);
    if (!contentObj || !Array.isArray(contentObj.parts)) continue;
    for (const part of contentObj.parts) {
      const partObj = asRecord(part);
      if (partObj && typeof partObj.text === "string" && partObj.text.trim()) {
        chunks.push(partObj.text);
      }
    }
  }
  const joined = chunks.join("\n").trim();
  if (!joined) {
    throw new Error("contents[].parts[].text must contain non-empty speech prompt text");
  }
  return joined;
}

function extractSpeakerConfigs(generationConfig: Record<string, unknown> | null): SpeechSpeakerInput[] {
  if (!generationConfig) return [];
  const speechConfig = asRecord(generationConfig.speech_config ?? generationConfig.speechConfig);
  if (!speechConfig) return [];

  const multi = asRecord(speechConfig.multi_speaker_voice_config ?? speechConfig.multiSpeakerVoiceConfig);
  const rawList = multi?.speaker_voice_configs ?? multi?.speakerVoiceConfigs;
  if (Array.isArray(rawList)) {
    const speakers: SpeechSpeakerInput[] = [];
    for (const entry of rawList) {
      const item = asRecord(entry);
      if (!item) continue;
      const speaker = typeof item.speaker === "string" ? item.speaker.trim() : "";
      const voiceCfg = asRecord(item.voice_config ?? item.voiceConfig);
      const prebuilt = asRecord(voiceCfg?.prebuilt_voice_config ?? voiceCfg?.prebuiltVoiceConfig);
      const voiceName = typeof prebuilt?.voice_name === "string"
        ? prebuilt.voice_name.trim()
        : typeof prebuilt?.voiceName === "string"
          ? prebuilt.voiceName.trim()
          : "";
      if (speaker && voiceName) {
        speakers.push({ speaker, voiceName });
      }
    }
    return speakers;
  }

  const singleVoiceCfg = asRecord(speechConfig.voice_config ?? speechConfig.voiceConfig);
  const singlePrebuilt = asRecord(singleVoiceCfg?.prebuilt_voice_config ?? singleVoiceCfg?.prebuiltVoiceConfig);
  const singleVoiceName = typeof singlePrebuilt?.voice_name === "string"
    ? singlePrebuilt.voice_name.trim()
    : typeof singlePrebuilt?.voiceName === "string"
      ? singlePrebuilt.voiceName.trim()
      : "";
  if (singleVoiceName) {
    return [{ speaker: "Speaker 1", voiceName: singleVoiceName }];
  }
  return [];
}

/**
 * Tầng nghiệp vụ cho endpoint tương thích Gemini TTS
 * (`/v1beta/models/:model:generateContent` và `:streamGenerateContent`):
 * chuyển payload Gemini TTS sang `AiStudioAdapter.runSpeechTurn` qua tab Launcher
 * và trả về cấu trúc JSON `candidates[0].content.parts[0].inlineData` chuẩn Gemini.
 */
export class GeminiSpeechService {
  constructor(
    private readonly adapterRegistry: AdapterRegistry = AdapterRegistry.getInstance(),
  ) {}

  private validateAndParse(
    modelId: string,
    raw: unknown,
  ): { ok: true; parsed: ParsedGeminiSpeechRequest } | { ok: false; message: string } {
    const body = asRecord(raw);
    if (!body) {
      return { ok: false, message: "Request body must be a JSON object" };
    }

    const cleanModel = modelId.trim();
    if (!cleanModel) {
      return { ok: false, message: "Missing Gemini TTS model id" };
    }

    const genConfig = asRecord(body.generationConfig ?? body.generation_config);
    const modalities = genConfig?.responseModalities ?? genConfig?.response_modalities;
    if (Array.isArray(modalities) && modalities.length > 0) {
      const supportsAudio = modalities.some(
        item => typeof item === "string" && item.trim().toLowerCase() === "audio",
      );
      if (!supportsAudio) {
        return {
          ok: false,
          message: "Only audio generation ('responseModalities: [\"audio\"]') is supported on /v1beta/models/* TTS route",
        };
      }
    } else if (!cleanModel.toLowerCase().includes("tts")) {
      return {
        ok: false,
        message: `Model '${cleanModel}' is not a TTS model and did not request audio responseModalities`,
      };
    }

    const rawTemp = genConfig?.temperature;
    let temperature: number | undefined;
    if (rawTemp !== undefined && rawTemp !== null) {
      if (typeof rawTemp !== "number" || !Number.isFinite(rawTemp) || rawTemp < 0 || rawTemp > 2) {
        return { ok: false, message: "'generationConfig.temperature' must be a finite number between 0 and 2" };
      }
      temperature = rawTemp;
    }

    try {
      const text = extractContentsText(body.contents);
      const speakers = extractSpeakerConfigs(genConfig);
      return {
        ok: true,
        parsed: {
          modelId: cleanModel,
          text,
          temperature,
          speakers,
        },
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Thực thi sinh giọng nói qua `AiStudioAdapter` và đóng gói response chuẩn Gemini.
   */
  public async executeSpeech(params: {
    req: Request;
    modelId: string;
    method: GeminiSpeechMethod;
    raw: unknown;
    adapterFactory?: ProviderAdapterFactory;
  }): Promise<Response> {
    const validated = this.validateAndParse(params.modelId, params.raw);
    if (!validated.ok) {
      return formatErrorResponse(400, "invalid_request_error", validated.message);
    }

    const { parsed } = validated;
    const abort = new AbortController();
    if (params.req.signal.aborted) abort.abort();
    else params.req.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const targetProviderId = parsed.modelId.toLowerCase().startsWith("ai-studio-pw/")
      ? "ai-studio-pw"
      : "ai-studio";

    try {
      const adapter = params.adapterFactory
        ? params.adapterFactory()
        : this.adapterRegistry.createAdapter(targetProviderId);
      if (typeof adapter.runSpeechTurn !== "function") {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `Configured '${targetProviderId}' adapter does not support TTS speech generation`,
        );
      }

      const result = await adapter.runSpeechTurn(
        {
          modelId: parsed.modelId,
          text: parsed.text,
          temperature: parsed.temperature,
          speakers: parsed.speakers,
        },
        {
          headers: params.req.headers,
          abortSignal: abort.signal,
        },
      );

      const candidateChunk = {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  inlineData: {
                    mimeType: result.mimeType,
                    data: result.audioBase64,
                  },
                },
              ],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
        modelVersion: parsed.modelId,
      };

      const url = new URL(params.req.url);
      if (params.method === "streamGenerateContent") {
        if (url.searchParams.get("alt")?.toLowerCase() === "sse") {
          return new Response(`data: ${JSON.stringify(candidateChunk)}\n\n`, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          });
        }
        return Response.json([candidateChunk]);
      }

      return Response.json(candidateChunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (abort.signal.aborted) {
        return formatErrorResponse(499, "request_aborted", message || "Request aborted by client");
      }
      return formatErrorResponse(502, "adapter_error", message);
    }
  }
}

