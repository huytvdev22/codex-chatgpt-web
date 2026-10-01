import { createM365CopilotAdapter } from "./adapters/m365-copilot";
import { isM365ModelSlug, availableM365ModelRoutes } from "./m365-models";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody } from "./http-body";
import type { AdapterEvent, CodexParsedRequest, CodexUsage } from "./types";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "developer";
  content: string | Array<{ type?: string; text?: string }>;
}

export interface OpenAIChatCompletionRequest {
  model?: string;
  messages?: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface OpenAIModelItem {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface OpenAIModelListResponse {
  object: "list";
  data: OpenAIModelItem[];
}

/**
 * Tạo danh mục model theo format chuẩn OpenAI:
 * { "object": "list", "data": [ { "id": "m365-copilot/gpt-5", ... } ] }
 */
export function buildOpenAIModelCatalog(): OpenAIModelListResponse {
  const routes = availableM365ModelRoutes();
  const data: OpenAIModelItem[] = routes.map(r => ({
    id: r.slug,
    object: "model",
    created: 1700000000,
    owned_by: "microsoft",
  }));

  // Đảm bảo tối thiểu có m365-copilot/gpt-5
  if (!data.some(d => d.id === "m365-copilot/gpt-5")) {
    data.unshift({
      id: "m365-copilot/gpt-5",
      object: "model",
      created: 1700000000,
      owned_by: "microsoft",
    });
  }

  return {
    object: "list",
    data,
  };
}

/**
 * Kiểm tra xem request GET /v1/models có phải đến từ Cursor / OpenAI-compatible client hay không.
 * Để đảm bảo không ảnh hưởng đến test suite và luồng Codex nội bộ:
 * Chỉ nhận diện là OpenAI client khi:
 * 1. User-Agent chứa "cursor" hoặc "openai"
 * 2. Header Authorization chứa "dummy" (thường dùng khi cấu hình Cursor/local proxy)
 * 3. URL có query param format=openai
 */
export function isOpenAIModelsRequest(req: Request): boolean {
  const ua = (req.headers.get("user-agent") ?? "").toLowerCase();
  const auth = (req.headers.get("authorization") ?? "").toLowerCase();
  const url = new URL(req.url);

  if (url.searchParams.get("format") === "openai") return true;
  if (ua.includes("cursor") || ua.includes("openai")) return true;
  if (auth.includes("dummy")) return true;

  return false;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Chuyển đổi payload OpenAI Chat Completions sang CodexParsedRequest để M365 adapter xử lý.
 */
export function parseOpenAIChatRequest(raw: unknown): {
  parsed: CodexParsedRequest;
  requestedModel: string;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Request body must be a JSON object");
  }

  const body = raw as OpenAIChatCompletionRequest;
  const requestedModel = typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : "m365-copilot/gpt-5";

  // Luôn hướng tới M365 modelId (nếu user gõ model khác như gpt-4o trên Cursor thì vẫn route sang M365 cho PoC)
  const modelId = isM365ModelSlug(requestedModel) ? requestedModel : "m365-copilot/gpt-5";

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("Request body requires a non-empty 'messages' array");
  }

  const systemPrompts: string[] = [];
  const messages: CodexParsedRequest["context"]["messages"] = [];

  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role;
    const text = extractMessageText(msg.content);

    if (role === "system") {
      if (text) systemPrompts.push(text);
    } else if (role === "user") {
      messages.push({
        role: "user",
        content: text,
        timestamp: Date.now(),
      });
    } else if (role === "assistant") {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
    } else if (role === "developer") {
      messages.push({
        role: "developer",
        content: text,
        timestamp: Date.now(),
      });
    }
  }

  if (messages.length === 0 && systemPrompts.length > 0) {
    messages.push({
      role: "user",
      content: "",
      timestamp: Date.now(),
    });
  }

  const parsed: CodexParsedRequest = {
    modelId,
    context: {
      systemPrompt: systemPrompts.length > 0 ? systemPrompts : undefined,
      messages,
    },
    stream: Boolean(body.stream),
    options: {
      temperature: body.temperature,
      maxOutputTokens: body.max_tokens,
    },
    _rawBody: raw,
    _openAICompat: true,
  };

  return { parsed, requestedModel };
}

function sseChunk(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Chuyển đổi dòng event từ M365 Adapter sang Server-Sent Events chuẩn OpenAI Chat Completions.
 */
export function bridgeToOpenAIChatSSE(
  queue: AsyncEventQueue<AdapterEvent>,
  model: string,
  onAbort?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 11)}`;
  const created = Math.floor(Date.now() / 1000);
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // 1. Chunk mở đầu với delta role: "assistant"
      const roleChunk = sseChunk({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      });
      controller.enqueue(encoder.encode(roleChunk));

      try {
        for await (const event of queue) {
          if (closed) break;

          if (event.type === "text_delta") {
            const chunk = sseChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: event.text },
                  finish_reason: null,
                },
              ],
            });
            controller.enqueue(encoder.encode(chunk));
          } else if (event.type === "error") {
            const errChunk = sseChunk({
              error: {
                message: event.message,
                type: "server_error",
                code: "adapter_error",
              },
            });
            controller.enqueue(encoder.encode(errChunk));
            break;
          } else if (event.type === "done") {
            const doneChunk = sseChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            });
            controller.enqueue(encoder.encode(doneChunk));
            break;
          }
        }
      } catch (err: unknown) {
        if (!closed) {
          const errChunk = sseChunk({
            error: {
              message: err instanceof Error ? err.message : String(err),
              type: "server_error",
            },
          });
          controller.enqueue(encoder.encode(errChunk));
        }
      } finally {
        if (!closed) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      onAbort?.();
      queue.close();
    },
  });
}

/**
 * Handler chính cho POST /v1/chat/completions (OpenAI Compatibility Layer)
 */
export async function handleOpenAIChatCompletions(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Request body must be valid JSON",
          type: "invalid_request_error",
          code: null,
        },
      },
      { status: 400 },
    );
  }

  let parsed: CodexParsedRequest;
  let requestedModel: string;
  try {
    const res = parseOpenAIChatRequest(raw);
    parsed = res.parsed;
    requestedModel = res.requestedModel;
  } catch (error) {
    return Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Invalid request",
          type: "invalid_request_error",
          code: null,
        },
      },
      { status: 400 },
    );
  }

  const adapter = createM365CopilotAdapter();
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();

  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const run = async () => {
    try {
      await adapter.runTurn(parsed, { headers: req.headers, abortSignal: abort.signal }, event => {
        queue.push(event);
      });
    } catch (error) {
      const event: AdapterEvent = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      queue.push(event);
    } finally {
      queue.close();
    }
  };

  // Streaming (stream=true)
  if (parsed.stream) {
    void run();
    const stream = bridgeToOpenAIChatSSE(queue, requestedModel, () => abort.abort());
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // Non-streaming (stream=false)
  await run();
  const events = await queue.collect();

  const errorEvent = events.find((e): e is Extract<AdapterEvent, { type: "error" }> => e.type === "error");
  if (errorEvent) {
    return Response.json(
      {
        error: {
          message: errorEvent.message,
          type: "server_error",
          code: "adapter_error",
        },
      },
      { status: 502 },
    );
  }

  let text = "";
  let usage: CodexUsage | undefined;
  for (const e of events) {
    if (e.type === "text_delta") text += e.text;
    if (e.type === "done" && e.usage) usage = e.usage;
  }

  const promptChars = parsed.context.messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 100),
    0,
  );
  const promptTokens = usage?.inputTokens ?? Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = usage?.outputTokens ?? Math.max(1, Math.ceil(text.length / 4));

  return Response.json({
    id: `chatcmpl-${Math.random().toString(36).slice(2, 11)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}
