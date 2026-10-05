import { logFunctionInput } from "../debug-logger";
/**
 * Đại diện 1:1 cấu trúc Raw JSON Request từ Codex IDE (Responses API wire format).
 * Tuân thủ nghiêm ngặt nguyên lý SOLID:
 * - Single Responsibility Principle (SRP): Chịu trách nhiệm lưu trữ cấu trúc DTO thô,
 *   bảo toàn parsed JSON snapshot và cung cấp các structural guards an toàn.
 * - Open/Closed Principle (OCP): Cho phép các bộ normalizer và adapters độc lập mở rộng
 *   mà không làm thay đổi cấu trúc dữ liệu raw wire.
 */

export type CodexRawContentBlock =
  | { type: "input_text" | "text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }
  | { type: "input_file"; file_id?: string; filename?: string }
  | { type: string; [key: string]: unknown };

export interface CodexRawMessageItem {
  type: "message";
  id?: string;
  role: string;
  content: string | CodexRawContentBlock[];
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexRawToolFunction {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  [key: string]: unknown;
}

export interface CodexRawToolNamespace {
  type: "namespace";
  name: string;
  description?: string;
  tools: CodexRawToolSpec[];
  [key: string]: unknown;
}

export interface CodexRawToolCustom {
  type: "custom";
  name: string;
  description?: string;
  format?: unknown;
  [key: string]: unknown;
}

export interface CodexRawToolSearch {
  type: "tool_search";
  execution?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export type CodexRawToolSpec =
  | CodexRawToolFunction
  | CodexRawToolNamespace
  | CodexRawToolCustom
  | CodexRawToolSearch
  | { type: string; name?: string; description?: string; [key: string]: unknown };

export interface CodexRawAdditionalToolsItem {
  type: "additional_tools";
  id?: string;
  role?: string;
  tools: CodexRawToolSpec[];
  [key: string]: unknown;
}

export interface CodexRawFunctionCallItem {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexRawFunctionCallOutputItem {
  type: "function_call_output";
  id?: string;
  call_id: string;
  output: unknown;
  [key: string]: unknown;
}

export interface CodexRawCustomToolCallItem {
  type: "custom_tool_call";
  id?: string;
  call_id: string;
  name: string;
  input: string;
  [key: string]: unknown;
}

export interface CodexRawCustomToolCallOutputItem {
  type: "custom_tool_call_output";
  id?: string;
  call_id: string;
  output: unknown;
  [key: string]: unknown;
}

export interface CodexRawCompactionTriggerItem {
  type: "compaction_trigger";
  [key: string]: unknown;
}

export type CodexRawInputItem =
  | CodexRawMessageItem
  | CodexRawAdditionalToolsItem
  | CodexRawFunctionCallItem
  | CodexRawFunctionCallOutputItem
  | CodexRawCustomToolCallItem
  | CodexRawCustomToolCallOutputItem
  | CodexRawCompactionTriggerItem
  | { type: string; [key: string]: unknown };

export interface CodexRawClientMetadata {
  thread_id?: string;
  turn_id?: string;
  "x-codex-turn-metadata"?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexRawRequestWire {
  model: string;
  stream?: boolean;
  store?: boolean;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  include?: string[];
  prompt_cache_key?: string;
  client_metadata?: CodexRawClientMetadata;
  tools?: CodexRawToolSpec[];
  input?: CodexRawInputItem[];
  reasoning?: {
    effort?: string;
    [key: string]: unknown;
  };
  text?: {
    verbosity?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Bộ kiểm tra cấu trúc Ingress (Structural Guard)
 * Chỉ kiểm tra tính an toàn của object trước khi nạp vào CodexRawPayload.
 */
export class CodexWireParser {
    /**
   * Kiểm tra một giá trị có phải là đối tượng bản ghi (Record) hợp lệ và không rỗng hay không.
   */
static isRecord(value: unknown): value is Record<string, unknown> {
    logFunctionInput("normalization:codex-raw-payload", "isRecord", { value });
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

    /**
   * Thực hiện xử lý CodexWireParser.parse cho quy trình M365 Copilot Adapter.
   */
static parse(raw: unknown): CodexRawRequestWire {
    logFunctionInput("normalization:codex-raw-payload", "parse", { raw });
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

    /**
   * Khởi tạo wrapper đóng gói payload request thô sau khi phân giải.
   */
constructor(raw: CodexRawRequestWire) {
    logFunctionInput("normalization:codex-raw-payload", "constructor", { raw });
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

    // Lưu trữ các thuộc tính mở rộng không có trong schema chuẩn
    const knownKeys = new Set([
      "model", "stream", "store", "tool_choice", "parallel_tool_calls",
      "include", "prompt_cache_key", "client_metadata", "tools", "input",
      "reasoning", "text"
    ]);
    this.extra = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!knownKeys.has(k)) {
        this.extra[k] = v;
      }
    }
  }

  /**
   * Factory khởi tạo an toàn từ dữ liệu chưa xác định (unknown)
   */
  static from(raw: unknown): CodexRawPayload {
    logFunctionInput("normalization:codex-raw-payload", "from", { raw });
    const parsedWire = CodexWireParser.parse(raw);
    return new CodexRawPayload(parsedWire);
  }

  /**
   * Trả về deep clone của parsed JSON object tại thời điểm khởi tạo.
   * Lưu ý: Phương thức này bảo toàn deep snapshot của parsed JSON object,
   * không đảm bảo bảo toàn nguyên vẹn raw HTTP bytes hay formatting ban đầu.
   */
  toJSON(): CodexRawRequestWire {
    logFunctionInput("normalization:codex-raw-payload", "toJSON");
    return structuredClone(this._rawSnapshot);
  }

  /**
   * Xuất chuỗi JSON từ snapshot
   */
  toRawJson(indent?: number): string {
    logFunctionInput("normalization:codex-raw-payload", "toRawJson", { indent });
    return JSON.stringify(this._rawSnapshot, null, indent);
  }

  /**
   * Trích xuất Thread ID từ client_metadata hoặc x-codex-turn-metadata
   */
  getThreadId(): string | undefined {
    logFunctionInput("normalization:codex-raw-payload", "getThreadId");
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

  /**
   * Trích xuất Turn ID từ client_metadata
   */
  getTurnId(): string | undefined {
    logFunctionInput("normalization:codex-raw-payload", "getTurnId");
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
