import type {
  CodexRawContentBlock,
  CodexRawMessageItem,
  CodexRawToolFunction,
  CodexRawToolNamespace,
  CodexRawToolCustom,
  CodexRawToolSearch,
  CodexRawToolSpec,
  CodexRawAdditionalToolsItem,
  CodexRawFunctionCallItem,
  CodexRawFunctionCallOutputItem,
  CodexRawCustomToolCallItem,
  CodexRawCustomToolCallOutputItem,
  CodexRawCompactionTriggerItem,
  CodexRawInputItem,
  CodexRawClientMetadata,
  CodexRawRequestWire,
} from "../dto/codex-raw-wire.dto";

/**
 * Bộ kiểm tra cấu trúc Ingress (Structural Guard).
 * Kiểm tra tính hợp lệ của object trước khi nạp vào CodexRawPayload.
 */
export class CodexWireParser {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static parse(raw: unknown): CodexRawRequestWire {
    if (!this.isRecord(raw)) {
      throw new TypeError("Codex request body must be a non-null object");
    }

    // Nếu request bọc trong _rawBody (từ middleware/adapter)
    const body = this.isRecord(raw._rawBody) ? raw._rawBody : raw;

    if (body.model !== undefined && typeof body.model !== "string") {
      throw new TypeError("Codex request field 'model' must be a string");
    }

    if (body.input !== undefined && !Array.isArray(body.input)) {
      throw new TypeError("Codex request field 'input' must be an array");
    }

    if (body.tools !== undefined && !Array.isArray(body.tools)) {
      throw new TypeError("Codex request field 'tools' must be an array");
    }

    if (body.client_metadata !== undefined && !this.isRecord(body.client_metadata)) {
      throw new TypeError("Codex request field 'client_metadata' must be an object");
    }

    return body as unknown as CodexRawRequestWire;
  }
}

/**
 * Container lưu trữ raw request từ Codex.
 * Bảo toàn deep snapshot của parsed JSON object tại thời điểm nhận request.
 * Không thay đổi default và không phụ thuộc vào adapter downstream.
 */
export class CodexRawPayload {
  readonly model: string;
  readonly stream?: boolean;
  readonly store?: boolean;
  readonly tool_choice?: unknown;
  readonly parallel_tool_calls?: boolean;
  readonly include?: string[];
  readonly prompt_cache_key?: string;
  readonly client_metadata?: CodexRawClientMetadata;
  readonly tools?: CodexRawToolSpec[];
  readonly input?: CodexRawInputItem[];
  readonly reasoning?: { effort?: string; [key: string]: unknown };
  readonly text?: { verbosity?: string; [key: string]: unknown };
  readonly extra: Record<string, unknown>;

  private readonly _rawSnapshot: CodexRawRequestWire;

  constructor(raw: CodexRawRequestWire) {
    this._rawSnapshot = structuredClone(raw);

    this.model = raw.model;
    this.stream = raw.stream;
    this.store = raw.store;
    this.tool_choice = raw.tool_choice;
    this.parallel_tool_calls = raw.parallel_tool_calls;
    this.include = raw.include;
    this.prompt_cache_key = raw.prompt_cache_key;
    this.client_metadata = raw.client_metadata;
    this.tools = raw.tools;
    this.input = raw.input;
    this.reasoning = raw.reasoning;
    this.text = raw.text;

    const knownKeys = new Set([
      "model",
      "stream",
      "store",
      "tool_choice",
      "parallel_tool_calls",
      "include",
      "prompt_cache_key",
      "client_metadata",
      "tools",
      "input",
      "reasoning",
      "text",
    ]);
    this.extra = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!knownKeys.has(k)) {
        this.extra[k] = v;
      }
    }
  }

  static from(raw: unknown): CodexRawPayload {
    const parsedWire = CodexWireParser.parse(raw);
    return new CodexRawPayload(parsedWire);
  }

  toJSON(): CodexRawRequestWire {
    return structuredClone(this._rawSnapshot);
  }

  toRawJson(indent?: number): string {
    return JSON.stringify(this._rawSnapshot, null, indent);
  }

  getThreadId(): string | undefined {
    if (this.client_metadata?.thread_id) {
      return String(this.client_metadata.thread_id);
    }
    const turnMeta = this.client_metadata?.["x-codex-turn-metadata"];
    if (turnMeta) {
      if (typeof turnMeta === "string") {
        try {
          const parsed = JSON.parse(turnMeta);
          if (parsed.thread_id) return String(parsed.thread_id);
        } catch { }
      } else if (typeof turnMeta === "object" && (turnMeta as any).thread_id) {
        return String((turnMeta as any).thread_id);
      }
    }
    return undefined;
  }

  getTurnId(): string | undefined {
    if (this.client_metadata?.turn_id) {
      return String(this.client_metadata.turn_id);
    }
    const turnMeta = this.client_metadata?.["x-codex-turn-metadata"];
    if (turnMeta) {
      if (typeof turnMeta === "string") {
        try {
          const parsed = JSON.parse(turnMeta);
          if (parsed.turn_id) return String(parsed.turn_id);
        } catch { }
      } else if (typeof turnMeta === "object" && (turnMeta as any).turn_id) {
        return String((turnMeta as any).turn_id);
      }
    }
    return undefined;
  }
}
