/**
 * Đại diện 1:1 cấu trúc Raw JSON Request từ Codex IDE (Responses API wire format).
 * Tuân thủ nghiêm ngặt nguyên lý SOLID:
 * - Single Responsibility Principle (SRP): Chịu trách nhiệm lưu trữ, đại diện 1:1
 *   và cung cấp các phương thức truy xuất / chuẩn hóa dữ liệu từ Codex.
 * - Open/Closed Principle (OCP): Cho phép mở rộng các bộ trích xuất và optimizer
 *   mà không làm thay đổi cấu trúc dữ liệu cốt lõi.
 */

export type CodexRawContentBlock =
  | { type: "input_text" | "text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }
  | { type: "input_file"; file_id?: string; filename?: string }
  | { type: string; [key: string]: unknown };

export interface CodexRawMessageItem {
  type: "message";
  id?: string;
  role: "developer" | "user" | "assistant" | string;
  content: string | CodexRawContentBlock[];
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexRawToolFunction {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
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
  arguments: string;
  [key: string]: unknown;
}

export interface CodexRawFunctionCallOutputItem {
  type: "function_call_output";
  id?: string;
  call_id: string;
  output: string | unknown;
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
  output: string | unknown;
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
  | CodexRawCompactionTriggerItem;

export interface CodexRawClientMetadata {
  thread_id?: string;
  turn_id?: string;
  "x-codex-turn-metadata"?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexRawRequestWire {
  model: string;
  stream?: boolean;
  prompt_cache_key?: string;
  client_metadata?: CodexRawClientMetadata;
  tools?: CodexRawToolSpec[];
  input?: CodexRawInputItem[];
  reasoning?: {
    effort?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ExtractedToolSummary {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface ExtractedToolResult {
  callId: string;
  output: string;
}

export interface ExtractedConversationTurn {
  role: "developer" | "user" | "assistant" | "tool";
  content: string;
  callId?: string;
  name?: string;
}

/**
 * Class đại diện 1:1 cấu trúc Raw JSON từ Codex IDE
 */
export class CodexRawPayload {
  readonly model: string;
  readonly stream: boolean;
  readonly prompt_cache_key?: string;
  readonly client_metadata: CodexRawClientMetadata;
  readonly tools: CodexRawToolSpec[];
  readonly input: CodexRawInputItem[];
  readonly reasoning?: { effort?: string; [key: string]: unknown };
  readonly extra: Record<string, unknown>;

  private readonly _rawSnapshot: CodexRawRequestWire;

  constructor(raw: CodexRawRequestWire) {
    this._rawSnapshot = structuredClone(raw);
    this.model = raw.model || "m365-copilot/think";
    this.stream = raw.stream ?? true;
    this.prompt_cache_key = raw.prompt_cache_key;
    this.client_metadata = raw.client_metadata || {};
    this.tools = Array.isArray(raw.tools) ? raw.tools : [];
    this.input = Array.isArray(raw.input) ? raw.input : [];
    this.reasoning = raw.reasoning;

    // Lưu các thuộc tính mở rộng khác (nếu có)
    const knownKeys = new Set(["model", "stream", "prompt_cache_key", "client_metadata", "tools", "input", "reasoning"]);
    this.extra = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!knownKeys.has(k)) {
        this.extra[k] = v;
      }
    }
  }

  /**
   * Factory khởi tạo 1:1 từ bất kỳ đối tượng request body nào của Codex
   */
  static from(raw: unknown): CodexRawPayload {
    if (!raw || typeof raw !== "object") {
      return new CodexRawPayload({ model: "m365-copilot/think", input: [] });
    }

    if (typeof (raw as any)._rawBody === "object" && (raw as any)._rawBody !== null) {
      return new CodexRawPayload((raw as any)._rawBody as CodexRawRequestWire);
    }

    return new CodexRawPayload(raw as CodexRawRequestWire);
  }

  /**
   * Xuất lại đúng 100% đối tượng Raw JSON gốc không suy suyển
   */
  toJSON(): CodexRawRequestWire {
    return structuredClone(this._rawSnapshot);
  }

  /**
   * Xuất chuỗi Raw JSON nguyên bản
   */
  toRawJson(indent?: number): string {
    return JSON.stringify(this._rawSnapshot, null, indent);
  }

  /**
   * Trích xuất Thread ID từ client_metadata hoặc x-codex-turn-metadata
   */
  getThreadId(): string | undefined {
    if (this.client_metadata.thread_id) {
      return String(this.client_metadata.thread_id);
    }
    const turnMeta = this.client_metadata["x-codex-turn-metadata"];
    if (turnMeta) {
      if (typeof turnMeta === "string") {
        try {
          const parsed = JSON.parse(turnMeta);
          if (parsed.thread_id) return String(parsed.thread_id);
        } catch {}
      } else if (typeof turnMeta === "object" && (turnMeta as any).thread_id) {
        return String((turnMeta as any).thread_id);
      }
    }
    return this.prompt_cache_key;
  }

  /**
   * Trích xuất Turn ID từ client_metadata
   */
  getTurnId(): string | undefined {
    if (this.client_metadata.turn_id) {
      return String(this.client_metadata.turn_id);
    }
    const turnMeta = this.client_metadata["x-codex-turn-metadata"];
    if (turnMeta) {
      if (typeof turnMeta === "string") {
        try {
          const parsed = JSON.parse(turnMeta);
          if (parsed.turn_id) return String(parsed.turn_id);
        } catch {}
      } else if (typeof turnMeta === "object" && (turnMeta as any).turn_id) {
        return String((turnMeta as any).turn_id);
      }
    }
    return undefined;
  }

  /**
   * Trích xuất nội dung văn bản thuần từ ContentBlock
   */
  private extractTextFromContent(content: string | CodexRawContentBlock[]): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map(b => {
          if (b.type === "input_text" || b.type === "text") return (b as any).text || "";
          if (b.type === "input_image") return "[Image]";
          if (b.type === "input_file") return `[File: ${(b as any).filename || (b as any).file_id || ""}]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  /**
   * Lấy yêu cầu mới nhất của người dùng (User Prompt của lượt hiện tại)
   */
  getLatestUserInstruction(): string {
    for (let i = this.input.length - 1; i >= 0; i--) {
      const item = this.input[i];
      if (item && (item.type === "message" || !item.type) && item.role === "user") {
        const text = this.extractTextFromContent(item.content);
        if (text.trim()) return text.trim();
      }
    }
    return "";
  }

  /**
   * Lấy toàn bộ các yêu cầu của người dùng từ trước đến nay
   */
  getAllUserInstructions(): string[] {
    const list: string[] = [];
    for (const item of this.input) {
      if (item && (item.type === "message" || !item.type) && item.role === "user") {
        const text = this.extractTextFromContent(item.content);
        if (text.trim()) list.push(text.trim());
      }
    }
    return list;
  }

  /**
   * Lấy các kết quả công cụ (Tool Results) vừa được trả về trong lượt này
   */
  getLatestToolResults(): ExtractedToolResult[] {
    const results: ExtractedToolResult[] = [];
    for (const item of this.input) {
      if (item && (item.type === "function_call_output" || item.type === "custom_tool_call_output")) {
        const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
        results.push({ callId: String(item.call_id || ""), output: out });
      }
    }
    return results;
  }

  /**
   * Lấy danh sách công cụ Codex cung cấp (kể cả trong additional_tools và root tools)
   */
  getAvailableTools(): ExtractedToolSummary[] {
    const tools: ExtractedToolSummary[] = [];

    const processToolSpec = (spec: CodexRawToolSpec) => {
      if (!spec || typeof spec !== "object") return;
      if (spec.type === "function" && spec.name) {
        tools.push({
          name: spec.name,
          description: spec.description || "",
          parameters: spec.parameters as Record<string, unknown> | undefined,
        });
      } else if (spec.type === "namespace" && Array.isArray(spec.tools)) {
        for (const sub of spec.tools) {
          processToolSpec(sub);
        }
      } else if (spec.name && typeof spec.name === "string") {
        tools.push({
          name: spec.name,
          description: spec.description || "",
          parameters: (spec as any).parameters,
        });
      }
    };

    // 1. Quét từ root tools
    for (const t of this.tools) {
      processToolSpec(t);
    }

    // 2. Quét từ additional_tools trong input
    for (const item of this.input) {
      if (item && item.type === "additional_tools" && Array.isArray(item.tools)) {
        for (const t of item.tools) {
          processToolSpec(t);
        }
      }
    }

    return tools;
  }

  /**
   * Trích xuất lịch sử các lượt trò chuyện (Conversation Messages)
   */
  getConversationHistory(): ExtractedConversationTurn[] {
    const history: ExtractedConversationTurn[] = [];

    for (const item of this.input) {
      if (!item) continue;
      if (item.type === "message" || (!item.type && (item.role === "user" || item.role === "assistant" || item.role === "system"))) {
        const text = this.extractTextFromContent(item.content);
        if (text.trim()) {
          history.push({
            role: item.role as any,
            content: text.trim(),
          });
        }
      } else if (item.type === "function_call") {
        history.push({
          role: "assistant",
          content: `<tool_call>\n{"name": "${item.name}", "arguments": ${item.arguments}}\n</tool_call>`,
          callId: String(item.call_id || ""),
          name: String(item.name || ""),
        });
      } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
        history.push({
          role: "tool",
          content: out,
          callId: String(item.call_id || ""),
        });
      }
    }

    return history;
  }

  /**
   * Xây dựng Prompt tối ưu token cho M365 Copilot từ Model 1:1 này.
   * Lọc bỏ hoàn toàn các metadata kỹ thuật rác, chỉ giữ lại những gì M365 cần:
   * 1. Vai trò Trợ lý Lập trình viên kết nối IDE.
   * 2. Giao thức xuất thẻ <tool_call>...</tool_call>.
   * 3. Danh sách các công cụ thực sự liên quan (lập trình, file, terminal).
   * 4. Lịch sử trao đổi và kết quả công cụ lượt gần nhất.
   * 5. Yêu cầu của người dùng.
   */
  buildOptimizedPrompt(options?: {
    maxHistoryTurns?: number;
    allowedToolNames?: string[];
  }): string {
    const lines: string[] = [];

    // 1. System Protocol
    lines.push(`[HỆ THỐNG GIAO TIẾP VĂN BẢN VỚI IDE - TEXT INTERACTION PROTOCOL]`);
    lines.push(`Bạn là Trợ lý Lập trình viên AI được kết nối trực tiếp với Codex IDE trên máy tính người dùng.`);
    lines.push(`QUY TẮC BẮT BUỘC:`);
    lines.push(`1. KHÔNG tự chạy trong sandbox /mnt/data của Copilot; container đám mây đó không thể truy cập mã nguồn trên máy tính người dùng.`);
    lines.push(`2. Để thao tác trên dự án (đọc file, xem thư mục, sửa code, chạy lệnh), bạn HÃY XUẤT CÂU LỆNH BASH (ví dụ: cat <file>, ls, git status) hoặc xuất khối văn bản:`);
    lines.push(`<tool_call>`);
    lines.push(`{"name": "TOOL_NAME", "arguments": {"ARG_KEY": "ARG_VALUE"}}`);
    lines.push(`</tool_call>`);
    lines.push(`Hệ thống IDE sẽ tự động bắt lấy lệnh bạn in ra, chạy trực tiếp trên dự án cục bộ và trả kết quả vào thẻ <tool_result> cho bạn ở lượt kế tiếp.\n`);

    // 2. Danh sách công cụ khả dụng được tinh gọn
    const allTools = this.getAvailableTools();
    const codingToolNames = new Set(options?.allowedToolNames || [
      "exec_command", "read_file", "write_file", "apply_patch",
      "list_dir", "grep_code", "search_files", "git_status", "git_diff", "run_command"
    ]);

    const activeTools = allTools.filter(t => codingToolNames.has(t.name));
    if (activeTools.length > 0) {
      lines.push(`[CÁC CÔNG CỤ CÓ SẴN TRONG IDE]:`);
      for (const t of activeTools) {
        lines.push(`- ${t.name}: ${t.description.split("\n")[0] || ""}`);
      }
      lines.push(``);
    }

    // 3. Kết quả Tool gần nhất (nếu là multi-step turn sau khi tool chạy xong)
    const toolResults = this.getLatestToolResults();
    if (toolResults.length > 0) {
      lines.push(`[KẾT QUẢ THỰC THI CÔNG CỤ VỪA NHẬN ĐƯỢC TỪ IDE]:`);
      for (const res of toolResults) {
        lines.push(`<tool_result id="${res.callId}">\n${res.output}\n</tool_result>`);
      }
      lines.push(`Hãy phân tích kết quả trên. Nếu cần thực hiện bước kế tiếp, hãy xuất ngay khối <tool_call> mới. Nếu đã hoàn thành nhiệm vụ, hãy trả lời kết luận cho người dùng.\n`);
    }

    // 4. Lịch sử hội thoại tinh gọn (chỉ lấy các lượt gần nhất)
    const history = this.getConversationHistory();
    const maxTurns = options?.maxHistoryTurns ?? 6;
    const recentHistory = history.slice(-maxTurns);

    if (recentHistory.length > 1 && toolResults.length === 0) {
      lines.push(`[LỊCH SỬ TRAO ĐỔI GẦN ĐÂY]:`);
      for (const h of recentHistory) {
        if (h.role === "user") {
          lines.push(`Người dùng: ${h.content}`);
        } else if (h.role === "assistant") {
          lines.push(`Trợ lý: ${h.content}`);
        }
      }
      lines.push(``);
    }

    // 5. Yêu cầu của người dùng
    const latestUser = this.getLatestUserInstruction();
    if (latestUser) {
      lines.push(`[YÊU CẦU CỦA NGƯỜI DÙNG]:`);
      lines.push(latestUser);
      lines.push(``);
    }

    // 6. Định dạng đầu ra
    lines.push(`[Yêu cầu định dạng đầu ra]: Hãy xuất ngay câu lệnh terminal tương ứng (ví dụ: cat <file>, ls) hoặc khối <tool_call> tương ứng để IDE thực thi trực tiếp trên dự án cục bộ thay vì chỉ viết hướng dẫn văn bản hoặc tự chạy trong sandbox /mnt/data.`);

    return lines.join("\n");
  }
}
