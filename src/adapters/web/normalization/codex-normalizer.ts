
import { compactionItemToText } from "../../../responses/compaction";
import type { CodexParsedRequest, CodexTool } from "../../../types";
import type {
  CodexRawPayload,
  CodexRawToolSpec,
  CodexRawInputItem,
  CodexRawContentBlock,
} from "./codex-raw-payload";
import {
  DEFAULT_MAX_INPUT_IMAGES,
  type NormalizedCodexRequest,
  type NormalizedTool,
  type NormalizedToolResult,
  type NormalizedTurn,
  type NormalizedExecutionPolicy,
  type NormalizedImageAttachment,
} from "./canonical-types";
import {
  extractDeferredToolNamespaces,
  sanitizeCodexBoilerplate,
} from "./instruction-sanitizer";
import { CodexSkillParser } from "../../../skills/codex-skill-parser";
import type { HostSkillEntry, SelectedSkillEntry } from "../../../skills/types";

export interface CodexNormalizeOptions {
  /** Giới hạn tối đa số lượng ảnh giữ lại trong 1 lượt (mặc định 3). */
  maxImages?: number;
  /** Tiền tố định danh `ref` cho ảnh đính kèm (mặc định `"web-img"`). */
  imageRefPrefix?: string;
  /** Kết quả đã parse từ `src/responses/parser.ts` để đồng nhất 100% tools/compaction/messages. */
  parsed?: CodexParsedRequest;
}

export class CodexPayloadNormalizer {
  /**
   * Trích xuất chuỗi văn bản thuần túy từ nội dung tin nhắn của Codex (hỗ trợ chuỗi đơn hoặc mảng content blocks).
   */
  private static extractTextFromContent(content: string | CodexRawContentBlock[]): string {

    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map(b => {
          if (!b || typeof b !== "object") return "";
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
   * Chuẩn hóa và chuyển đổi đầu ra của công cụ (output) thành chuỗi string an toàn.
   * Xử lý riêng mảng content blocks (tránh stringify base64 input_image từ view_image vào text).
   */
  private static stringifyToolOutput(output: unknown): string {
    if (typeof output === "string") return output;
    if (Array.isArray(output)) {
      const parts: string[] = [];
      for (const block of output) {
        if (typeof block === "string") {
          parts.push(block);
          continue;
        }
        if (!block || typeof block !== "object") continue;
        const rec = block as Record<string, unknown>;
        if (
          (rec.type === "input_text" || rec.type === "output_text" || rec.type === "text") &&
          typeof rec.text === "string"
        ) {
          parts.push(rec.text);
        } else if (rec.type === "refusal" && typeof rec.refusal === "string") {
          parts.push(`[refusal: ${rec.refusal}]`);
        } else if (rec.type === "encrypted_content") {
          parts.push("[encrypted content omitted]");
        } else if (rec.type === "input_image") {
          const detail = typeof rec.detail === "string" ? ` (${rec.detail})` : "";
          parts.push(`[image attached${detail}]`);
        } else if (rec.type === "input_file") {
          parts.push(`[file: ${String(rec.filename || rec.file_id || "?")}]`);
        }
      }
      return parts.join("\n");
    }
    const serialized = JSON.stringify(output ?? "");
    return serialized ?? "";
  }

  private static formatEnvironmentTimestamp(dateText?: string, tz?: string): string {
    if (dateText && /\d{2}:\d{2}/.test(dateText)) {
      return tz ? `${dateText} (${tz})` : dateText;
    }

    const now = new Date();
    const formatWithZone = (timeZone?: string): { dateStr: string; timeStr: string } => {
      const parts = new Intl.DateTimeFormat("en-CA", {
        ...(timeZone ? { timeZone } : {}),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(now);

      const get = (type: string) => parts.find(p => p.type === type)?.value || "00";
      return {
        dateStr: `${get("year")}-${get("month")}-${get("day")}`,
        timeStr: `${get("hour")}:${get("minute")}:${get("second")}`,
      };
    };

    let formatted: { dateStr: string; timeStr: string };
    try {
      formatted = formatWithZone(tz);
    } catch {
      formatted = formatWithZone(undefined);
    }

    const effectiveDate = dateText || formatted.dateStr;
    const timestamp = `${effectiveDate} ${formatted.timeStr}`;
    return tz ? `${timestamp} (${tz})` : timestamp;
  }

  private static extractEnvironmentFields(rawEnv: string): {
    cwd?: string;
    shell?: string;
    date?: string;
    tz?: string;
    ws?: string;
    rawFallback?: string;
  } {
    const cwd = rawEnv.match(/<cwd>([\s\S]*?)<\/cwd>/i)?.[1]?.trim();
    const shell = rawEnv.match(/<shell>([\s\S]*?)<\/shell>/i)?.[1]?.trim();
    const date = rawEnv.match(/<current_date>([\s\S]*?)<\/current_date>/i)?.[1]?.trim();
    const tz = rawEnv.match(/<timezone>([\s\S]*?)<\/timezone>/i)?.[1]?.trim();
    const ws = rawEnv.match(/<workspace_roots>[\s\S]*?<root>([\s\S]*?)<\/root>/i)?.[1]?.trim();

    if (!cwd && !shell && !date && !tz && !ws) {
      const rawFallback = rawEnv.trim();
      return rawFallback ? { rawFallback } : {};
    }
    return {
      ...(cwd ? { cwd } : {}),
      ...(shell ? { shell } : {}),
      ...(date ? { date } : {}),
      ...(tz ? { tz } : {}),
      ...(ws ? { ws } : {}),
    };
  }

  /**
   * Định dạng thông tin môi trường làm việc gọn gàng, loại bỏ toàn bộ XML rác của macOS seatbelt sandbox.
   */
  private static formatEnvironmentFields(fields: {
    cwd?: string;
    shell?: string;
    date?: string;
    tz?: string;
    ws?: string;
    rawFallback?: string;
  }): string | undefined {
    const { cwd, shell, date, tz, ws, rawFallback } = fields;
    const parts: string[] = [];
    if (cwd) parts.push(`- Thư mục làm việc (cwd): ${cwd}`);
    if (shell) parts.push(`- Shell: ${shell}`);
    if (date || tz) parts.push(`- Thời gian: ${this.formatEnvironmentTimestamp(date, tz)}`);
    if (ws && ws !== cwd) parts.push(`- Workspace: ${ws}`);

    if (parts.length > 0) return parts.join("\n");
    return rawFallback || undefined;
  }

  /**
   * Nhận diện các tin nhắn hệ thống nội bộ của OpenAI Codex CLI để loại trừ hoàn toàn khỏi priorHistory.
   */
  private static isInternalSystemMessage(item: CodexRawInputItem, text: string): boolean {
    const meta = (item as any).internal_chat_message_metadata_passthrough;
    const kinds = Array.isArray(meta?.content_item_kinds) ? ((meta.content_item_kinds as unknown[]) as string[]) : [];

    const systemKinds = [
      "environments.environment_context",
      "additional_content.codex_apps_client_time_context",
      "host_skills.instructions",
      "permissions.instructions",
      "collaboration_mode.instructions",
      "model.base_instructions",
      "agents_md.instructions",
      "images.resize_notice",
      "tools.deferred_namespaces",
    ];

    if (kinds.some(k => systemKinds.includes(k))) {
      return true;
    }

    const trimmed = text.trim();
    if (
      trimmed.startsWith("<environment_context>") ||
      trimmed.startsWith("<external_codex_apps_open_page>") ||
      trimmed.startsWith("<codex_apps_client_time_context>") ||
      trimmed.startsWith("<codex_apps_open_page_instructions>") ||
      trimmed.startsWith("<image_resize_notice>") ||
      trimmed.startsWith("<recommended_plugins>") ||
      trimmed.startsWith("<skills_instructions>") ||
      trimmed.startsWith("<permissions") ||
      trimmed.startsWith("<collaboration_mode>") ||
      trimmed.startsWith("<tools>") ||
      trimmed.startsWith("# AGENTS.md instructions") ||
      trimmed.includes("<INSTRUCTIONS>")
    ) {
      return true;
    }

    return false;
  }

  /**
   * Lọc sạch toàn bộ boilerplate nội bộ của Codex IDE khỏi developerInstructions,
   * chỉ giữ lại các chỉ thị thực sự của người dùng hoặc dự án (nếu có).
   */
  private static cleanDeveloperInstructions(text: string): string {
    return sanitizeCodexBoilerplate(text);
  }

  private static convertParsedTools(parsedTools: CodexTool[]): NormalizedTool[] {
    const tools: NormalizedTool[] = [];
    const seen = new Set<string>();

    for (const tool of parsedTools) {
      if (!tool || !tool.name) continue;
      const qualifiedName = tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name;
      if (seen.has(qualifiedName)) continue;
      seen.add(qualifiedName);

      const identity = {
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        name: tool.name,
        qualifiedName,
      };

      if (tool.freeform) {
        tools.push({
          kind: "custom",
          identity,
          description: tool.description || "",
          format: {
            type: "grammar",
            syntax: "lark",
          },
        });
      } else {
        tools.push({
          kind: "function",
          identity,
          description: tool.description || "",
          strict: tool.strict,
          ...(tool.toolSearch ? { isToolSearch: true } : {}),
          rawParameters: (tool.parameters as Record<string, unknown>) || {},
        });
      }
    }

    return tools;
  }

  private static formatToolSearchOutput(item: {
    status?: unknown;
    tools?: unknown;
  }): string {
    const specs = Array.isArray(item.tools) ? (item.tools as CodexRawToolSpec[]) : [];
    const wireNames: string[] = [];
    for (const spec of specs) {
      if (!spec || typeof spec !== "object") continue;
      if (spec.type === "namespace" && Array.isArray(spec.tools)) {
        const ns =
          typeof spec.name === "string" && spec.name !== "functions" && spec.name.length > 0
            ? spec.name
            : undefined;
        for (const inner of spec.tools) {
          if (inner && typeof inner === "object" && typeof inner.name === "string") {
            wireNames.push(ns ? `${ns}.${inner.name}` : inner.name);
          }
        }
      } else if (typeof spec.name === "string" && spec.name.length > 0) {
        wireNames.push(spec.name);
      }
    }

    const failed =
      typeof item.status === "string" &&
      item.status !== "completed" &&
      item.status !== "success";
    if (failed && wireNames.length === 0) {
      return `Tool search failed (status: ${item.status}).`;
    }
    if (wireNames.length > 0) {
      return `Tool search loaded these tools — they are now available. Call by EXACT name (use tools.describe if you need inputSchema): ${wireNames.join(", ")}.`;
    }
    return "Tool search returned no tools.";
  }

  /**
   * Chuẩn hóa toàn bộ danh sách công cụ từ root tools, additional_tools và tool_search_output trong input.
   * Bảo toàn namespace, qualifiedName, tool_search và lưu trữ rawParameters/format nguyên vẹn.
   */
  static extractTools(rawPayload: CodexRawPayload): NormalizedTool[] {
    const tools: NormalizedTool[] = [];
    const seen = new Set<string>();
    const DEFAULT_FUNCTION_NAMESPACE = "functions";

    /**
     * Chuẩn hóa định nghĩa công cụ thô (raw tool spec) từ Codex thành định dạng công cụ chuẩn (Canonical Tool).
     */
    const processSpec = (spec: CodexRawToolSpec, namespace?: string) => {
      if (!spec || typeof spec !== "object") return;

      if (spec.type === "namespace" && Array.isArray(spec.tools)) {
        // Namespace "functions" là nhóm mặc định của Codex cho các native functions
        // Tuyệt đối không gán tiền tố "functions." để tránh sinh ra functions.exec_command làm hỏng tool call
        const isDefaultFunctions = spec.name === DEFAULT_FUNCTION_NAMESPACE;
        const nextNs = isDefaultFunctions
          ? namespace
          : (namespace ? `${namespace}.${spec.name}` : spec.name);
        for (const sub of spec.tools) {
          processSpec(sub, nextNs);
        }
        return;
      }

      if (spec.type === "tool_search") {
        if (seen.has("tool_search")) return;
        seen.add("tool_search");
        tools.push({
          kind: "function",
          identity: { name: "tool_search", qualifiedName: "tool_search" },
          description:
            typeof spec.description === "string" && spec.description.trim().length > 0
              ? spec.description
              : "Search for additional/deferred tools (such as subagents or extra MCP tools) to load for the next turn.",
          strict: false,
          isToolSearch: true,
          rawParameters:
            spec.parameters && typeof spec.parameters === "object"
              ? (spec.parameters as Record<string, unknown>)
              : {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "Search query for tools to load." },
                    limit: { type: "number", description: "Maximum number of tools to return." },
                  },
                  required: ["query"],
                },
        });
        return;
      }

      const name = spec.name;
      if (!name || typeof name !== "string") return;

      // Đồng bộ với src/responses/parser.ts: non-default custom tools không expose thành function trực tiếp
      if (spec.type === "custom" && namespace) {
        return;
      }

      const qualifiedName = namespace ? `${namespace}.${name}` : name;
      if (seen.has(qualifiedName)) return;
      seen.add(qualifiedName);

      const identity = { namespace, name, qualifiedName };
      const description = spec.description || "";

      if (spec.type === "custom") {
        tools.push({
          kind: "custom",
          identity,
          description,
          format: spec.format,
        });
      } else {
        // Mặc định kiểu function (kể cả function hoặc spec có parameters)
        tools.push({
          kind: "function",
          identity,
          description,
          strict: (spec as any).strict,
          rawParameters: ((spec as any).parameters as Record<string, unknown>) || {},
        });
      }
    };

    // 1. Quét từ root tools
    if (Array.isArray(rawPayload.tools)) {
      for (const t of rawPayload.tools) {
        processSpec(t);
      }
    }

    // 2. Quét từ additional_tools và tool_search_output trong input
    if (Array.isArray(rawPayload.input)) {
      for (const item of rawPayload.input) {
        if (item && item.type === "additional_tools" && Array.isArray(item.tools)) {
          for (const t of item.tools) {
            processSpec(t);
          }
        } else if (item && item.type === "tool_search_output" && Array.isArray((item as any).tools)) {
          for (const t of (item as any).tools) {
            processSpec(t);
          }
        }
      }
    }

    return tools;
  }

  /**
   * Trích xuất nhóm kết quả công cụ ở cuối turn (Trailing Tool Results).
   * Thuật toán:
   * - Quét ngược từ cuối input lên đầu.
   * - Thu thập các function_call_output, custom_tool_call_output hoặc tool_search_output.
   * - Bỏ qua các control item trong suốt (như compaction_trigger, context_compaction).
   * - Dừng lại ngay khi gặp item thuộc về turn trước đó sau khi đã thu được ít nhất 1 output.
   * - Ghép nối call_id ngược về tool call tương ứng để xác định tên tool và kind.
   */
  static extractTrailingToolResults(rawPayload: CodexRawPayload): NormalizedToolResult[] {
    const input = rawPayload.input || [];
    const trailingResults: NormalizedToolResult[] = [];

    // Tạo map call_id -> { name, kind } từ toàn bộ input để tra cứu
    const callMap = new Map<string, { name: string; kind: "function" | "custom" }>();
    for (const item of input) {
      if (!item) continue;
      if (item.type === "function_call" && item.call_id) {
        callMap.set(String(item.call_id), { name: String(item.name || ""), kind: "function" });
      } else if (item.type === "custom_tool_call" && item.call_id) {
        callMap.set(String(item.call_id), { name: String(item.name || ""), kind: "custom" });
      } else if (item.type === "tool_search_call") {
        const callId = String((item as any).call_id || (item as any).id || "");
        if (callId) {
          callMap.set(callId, { name: "tool_search", kind: "function" });
        }
      }
    }

    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (!item) continue;

      if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        const callId = String(item.call_id || "");
        const callInfo = callMap.get(callId);
        trailingResults.unshift({
          callId,
          toolName: callInfo?.name,
          kind: callInfo?.kind || (item.type === "custom_tool_call_output" ? "custom" : "function"),
          output: this.stringifyToolOutput(item.output),
        });
        continue;
      }

      if (item.type === "tool_search_output") {
        const callId = String((item as any).call_id || "");
        trailingResults.unshift({
          callId,
          toolName: "tool_search",
          kind: "function",
          output: this.formatToolSearchOutput(item as { status?: unknown; tools?: unknown }),
        });
        continue;
      }

      // Bỏ qua các control items trong suốt không làm đứt trailing group
      if (item.type === "compaction_trigger" || item.type === "context_compaction") {
        continue;
      }

      // Nếu đã thu thập được tool output và gặp item khác (như message hoặc turn boundary trước) -> dừng lại
      if (trailingResults.length > 0) {
        break;
      }

      // Nếu gặp message hoặc turn boundary trước khi tìm thấy bất kỳ tool output nào -> không có trailing tool results
      if (
        item.type === "message" ||
        item.type === "function_call" ||
        item.type === "custom_tool_call" ||
        item.type === "tool_search_call"
      ) {
        break;
      }
    }

    return trailingResults;
  }

  /**
   * Tìm vị trí (index) của yêu cầu người dùng mới nhất (Latest User Instruction).
   * Ưu tiên message có metadata content_item_kinds chứa 'user.text'.
   */
  static findLatestUserItemIndex(input: CodexRawInputItem[]): number {

    let fallbackIndex = -1;

    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (!item) continue;

      const isUserRole = item.role === "user" || (item.type === "message" && item.role === "user");
      if (!isUserRole) continue;

      const text = this.extractTextFromContent((item as any).content);
      if (CodexSkillParser.isSelectedSkillItem(item as any, text)) {
        continue;
      }

      // Kiểm tra metadata xem có phải là user request thật hay không
      const meta = (item as any).internal_chat_message_metadata_passthrough;
      const kinds = Array.isArray(meta?.content_item_kinds) ? ((meta.content_item_kinds as unknown[]) as string[]) : [];

      if (kinds.includes("user.text")) {
        return i;
      }

      // Lưu lại user message đầu tiên tìm thấy từ dưới lên làm fallback
      if (fallbackIndex === -1) {
        fallbackIndex = i;
      }
    }

    return fallbackIndex;
  }

  /**
   * Chuyển đổi mảng context.messages từ CodexParsedRequest sang CodexRawInputItem
   * nhằm hỗ trợ tương thích 100% khi request không có raw wire input (mock test hoặc pipeline cũ).
   */
  static convertMessagesToInput(messages: Array<any>): CodexRawInputItem[] {

    const input: CodexRawInputItem[] = [];
    for (const msg of messages || []) {
      if (!msg) continue;
      if (msg.role === "toolResult") {
        input.push({
          type: "function_call_output",
          call_id: msg.toolCallId || msg.callId || "",
          output: msg.content,
          name: msg.toolName,
        } as any);
      } else if (msg.role === "assistant") {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && part.type === "toolCall") {
              input.push({
                type: "function_call",
                call_id: part.id || "",
                name: part.name || "",
                arguments: part.arguments || {},
              } as any);
            } else if (part && part.type === "text") {
              input.push({
                type: "message",
                role: "assistant",
                content: part.text,
              } as any);
            }
          }
        } else {
          input.push({
            type: "message",
            role: "assistant",
            content: typeof msg.content === "string" ? msg.content : "",
          } as any);
        }
      } else {
        input.push({
          type: "message",
          role: msg.role || "user",
          content: typeof msg.content === "string" ? msg.content : (Array.isArray(msg.content) ? msg.content : ""),
        } as any);
      }
    }
    return input;
  }

  /**
   * Chuẩn hóa toàn bộ request từ CodexRawPayload sang NormalizedCodexRequest.
   */
  static normalize(
    rawPayload: CodexRawPayload,
    options?: CodexNormalizeOptions,
  ): NormalizedCodexRequest {

    const rawContextMsgs = (rawPayload as any).context?.messages || (rawPayload.extra as any)?.context?.messages;
    const input = (rawPayload.input && rawPayload.input.length > 0)
      ? rawPayload.input
      : (Array.isArray(rawContextMsgs) ? this.convertMessagesToInput(rawContextMsgs) : []);

    const parsedTools = options?.parsed?.context?.tools;
    const tools =
      Array.isArray(parsedTools) && parsedTools.length > 0
        ? this.convertParsedTools(parsedTools)
        : this.extractTools(rawPayload);
    // Nếu tools rỗng nhưng có context.tools trên rawPayload, bổ sung từ context.tools
    const rawContextTools = (rawPayload as any).context?.tools || (rawPayload.extra as any)?.context?.tools;
    if (tools.length === 0 && Array.isArray(rawContextTools)) {
      for (const t of rawContextTools) {
        if (t && t.name) {
          tools.push({
            kind: t.freeform ? "custom" : "function",
            identity: {
              ...(t.namespace ? { namespace: t.namespace } : {}),
              name: t.name,
              qualifiedName: t.namespace ? `${t.namespace}.${t.name}` : t.name,
            },
            description: t.description || "",
            ...(t.toolSearch ? { isToolSearch: true } : {}),
            rawParameters: t.parameters || {},
          });
        }
      }
    }

    // Ghép call_id cho trailing tool results nếu input đến từ context.messages
    const trailingToolResults = this.extractTrailingToolResults({ ...rawPayload, input } as any);

    // Xác định latest user message và làm sạch các tiêu đề Markdown thô của Codex IDE
    const latestUserIdx = this.findLatestUserItemIndex(input);
    let latestUserInstruction: string | undefined;
    if (latestUserIdx !== -1) {
      const text = this.extractTextFromContent((input[latestUserIdx] as any).content);
      if (text.trim()) {
        // Chuẩn hóa các template heading thô của Codex IDE thành văn bản tự nhiên
        // để tránh kích hoạt ProseMirror Heading Parser trên ChatGPT Web làm vỡ con trỏ
        latestUserInstruction = text
          .replace(/# Context from my IDE setup:/gi, "[Ngữ cảnh từ IDE]:")
          .replace(/## Active file:/gi, "- File đang mở:")
          .replace(/## Open tabs:/gi, "- Các tab đang mở:")
          .replace(/## My request:/gi, "[Yêu cầu cụ thể của mình]:")
          .trim();
      }
    }

    // Trích xuất developerInstructions, deferredNamespaces và environmentContext mới nhất từ input
    const developerInstructions: string[] = [];
    const deferredNamespaces: string[] = [];
    let latestEnvFields: {
      cwd?: string;
      shell?: string;
      date?: string;
      tz?: string;
      ws?: string;
      rawFallback?: string;
    } | null = null;

    // Xác định ranh giới turn hiện tại (sau assistant message cuối cùng trước/bằng latestUserIdx)
    // để tách riêng selectedSkills được chọn cho lượt hiện tại.
    let currentTurnStartIdx = 0;
    const scanUpperBound = latestUserIdx !== -1 ? latestUserIdx : input.length - 1;
    for (let i = scanUpperBound; i >= 0; i--) {
      const candidate = input[i];
      if (!candidate) continue;
      const isAssistantMsg =
        candidate.role === "assistant" ||
        (candidate.type === "message" && candidate.role === "assistant");
      if (isAssistantMsg) {
        currentTurnStartIdx = i + 1;
        break;
      }
    }

    const rawHostSkillTexts: string[] = [];
    const selectedSkills: SelectedSkillEntry[] = [];

    // Xây dựng priorHistory: LOẠI BỎ hoàn toàn latest user item và các tin nhắn hệ thống nội bộ của Codex
    const priorHistory: NormalizedTurn[] = [];
    for (let i = 0; i < input.length; i++) {
      if (i === latestUserIdx) {
        // Bỏ qua item người dùng mới nhất, vì nó sẽ được render riêng ở cuối prompt
        continue;
      }

      const item = input[i];
      if (!item) continue;

      let text = "";
      if (item.type === "message" || (!item.type && (item.role === "user" || item.role === "developer" || item.role === "assistant"))) {
        text = this.extractTextFromContent((item as any).content);
      } else if (item.type === "agent_message") {
        text = this.extractTextFromContent((item as any).content || "");
      }

      if (text && text.includes("<skills_instructions>")) {
        rawHostSkillTexts.push(text);
      }

      if (text && CodexSkillParser.isSelectedSkillItem(item as any, text)) {
        if (i >= currentTurnStartIdx) {
          const parsedSkill = CodexSkillParser.parseSelectedSkill(text);
          if (parsedSkill) {
            selectedSkills.push(parsedSkill);
          }
        }
        continue;
      }

      if (text) {
        for (const nsEntry of extractDeferredToolNamespaces(text)) {
          if (!deferredNamespaces.includes(nsEntry)) {
            deferredNamespaces.push(nsEntry);
          }
        }
      }

      // Trích xuất environmentContext nếu có; ghi đè bằng giá trị mới nhất để tránh lặp qua nhiều lượt
      const envMatch = text.match(/<environment_context>([\s\S]*?)<\/environment_context>/i);
      if (envMatch) {
        latestEnvFields = {
          ...(latestEnvFields ?? {}),
          ...this.extractEnvironmentFields(envMatch[1]),
        };
      }

      // Trích xuất chỉ dẫn AGENTS.md / Project Instructions từ bất kỳ message nào (kể cả user, developer hay preamble)
      const instructionRegex = /<INSTRUCTIONS>([\s\S]*?)<\/INSTRUCTIONS>/gi;
      let instMatch: RegExpExecArray | null;
      let foundInstructions = false;
      while ((instMatch = instructionRegex.exec(text)) !== null) {
        const instruction = instMatch[1].trim();
        if (instruction && !developerInstructions.includes(instruction)) {
          developerInstructions.push(instruction);
          foundInstructions = true;
        }
      }
      if (!foundInstructions && text.includes("# AGENTS.md instructions")) {
        const cleaned = text
          .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
          .replace(/# AGENTS\.md instructions[^\n]*/gi, "")
          .trim();
        if (cleaned && !developerInstructions.includes(cleaned)) {
          developerInstructions.push(cleaned);
        }
      }

      const isDev = item.role === "developer" || (item.type === "message" && item.role === "developer");
      if (isDev) {
        const cleaned = this.cleanDeveloperInstructions(text);
        if (cleaned && cleaned.length > 5 && !cleaned.includes("You are Codex") && !developerInstructions.includes(cleaned)) {
          developerInstructions.push(cleaned);
        }
        continue;
      }

      // LOẠI BỎ TRIỆT ĐỂ: Nếu là tin nhắn hệ thống nội bộ của Codex (environment, app page, time context, plugins...)
      // Tuyệt đối không đưa vào priorHistory để tránh làm ô nhiễm lịch sử trò chuyện của người dùng!
      if (this.isInternalSystemMessage(item, text)) {
        continue;
      }

      if (item.type === "compaction_trigger") {
        continue;
      }

      if (item.type === "compaction" || item.type === "compaction_summary" || item.type === "context_compaction") {
        const encrypted = (item as any).encrypted_content;
        if (item.type === "context_compaction" && typeof encrypted !== "string") {
          continue;
        }
        const summaryText = compactionItemToText(typeof encrypted === "string" ? encrypted : undefined);
        if (summaryText) {
          priorHistory.push({
            role: "user",
            content: `[Tóm tắt ngữ cảnh trước đó]:\n${summaryText}`,
          });
        }
        continue;
      }

      if (item.type === "agent_message") {
        if (text.trim()) {
          const author = typeof (item as any).author === "string" ? (item as any).author : "subagent";
          const recipient = typeof (item as any).recipient === "string" ? ` -> ${(item as any).recipient}` : "";
          priorHistory.push({
            role: "user",
            content: `[Tin nhắn từ agent ${author}${recipient}]:\n${text.trim()}`,
          });
        }
        continue;
      }

      if (item.type === "message" || (!item.type && (item.role === "user" || item.role === "assistant"))) {
        if (text.trim()) {
          priorHistory.push({
            id: (item as any).id ? String((item as any).id) : undefined,
            role: (item.role || "user") as any,
            content: text.trim(),
            isUserText: item.role === "user",
          });
        }
      } else if (item.type === "function_call") {
        const argsStr = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {});
        priorHistory.push({
          role: "assistant",
          content: `<tool_call>\n{"name": "${item.name}", "arguments": ${argsStr}}\n</tool_call>`,
          callId: String(item.call_id || ""),
          toolName: String(item.name || ""),
        });
      } else if (item.type === "custom_tool_call") {
        priorHistory.push({
          role: "assistant",
          content: `<custom_tool_call name="${item.name}">\n${item.input}\n</custom_tool_call>`,
          callId: String(item.call_id || ""),
          toolName: String(item.name || ""),
        });
      } else if (item.type === "tool_search_call") {
        const argsStr = JSON.stringify((item as any).arguments || {});
        priorHistory.push({
          role: "assistant",
          content: `<tool_call>\n{"name": "tool_search", "arguments": ${argsStr}}\n</tool_call>`,
          callId: String((item as any).call_id || (item as any).id || ""),
          toolName: "tool_search",
        });
      } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        priorHistory.push({
          role: "tool",
          content: this.stringifyToolOutput(item.output),
          callId: String(item.call_id || ""),
        });
      } else if (item.type === "tool_search_output") {
        priorHistory.push({
          role: "tool",
          content: this.formatToolSearchOutput(item as { status?: unknown; tools?: unknown }),
          callId: String((item as any).call_id || ""),
          toolName: "tool_search",
        });
      }
    }

    // Phase 1: Tool Intelligence Preservation
    // Loại bỏ hoàn toàn whitelist cứng để bảo toàn toàn bộ công cụ do Codex cung cấp.
    // Toàn bộ các công cụ từ request (request_user_input, create_goal, update_goal, get_goal, web.run, tool_search, exec_command, apply_patch, write_stdin, v.v.)
    // đều được bảo toàn trong activeCodingTools.
    // Chỉ loại bỏ công cụ khi có lý do kỹ thuật rõ ràng và được ghi chú comment cụ thể.
    const filteredTools: Array<{ tool: NormalizedTool; reason: string }> = [];
    const activeCodingTools: NormalizedTool[] = [];

    for (const tool of tools) {
      // Lý do loại bỏ 1: Công cụ không có tên hợp lệ hoặc tên rỗng -> không thể định danh để gọi qua protocol
      if (!tool.identity.name || tool.identity.name.trim() === "") {
        filteredTools.push({
          tool,
          reason: "Tên công cụ bị rỗng hoặc không xác định",
        });
        continue;
      }

      // Giữ lại 100% công cụ hợp lệ từ Codex request
      activeCodingTools.push(tool);
    }

    // Sinh log thống kê theo yêu cầu Phase 1
    console.log(
      `[normalizer]\ntotalTools=${tools.length}\nactiveTools=${activeCodingTools.length}\nfilteredTools=${filteredTools.length}`
    );

    const executionPolicy: NormalizedExecutionPolicy = {
      parallelToolCalls: rawPayload.parallel_tool_calls ?? false,
      toolChoice: rawPayload.tool_choice,
    };

    const images = this.extractImages(rawPayload, options);

    const systemInstructions = options?.parsed?.context?.systemPrompt?.filter(Boolean);
    const resolvedWorkspaceCwd = latestEnvFields?.cwd;
    const availableSkills: HostSkillEntry[] = [];
    const seenAvailableSkills = new Set<string>();
    for (const rawSkillText of rawHostSkillTexts) {
      for (const entry of CodexSkillParser.extractHostSkills(rawSkillText, resolvedWorkspaceCwd)) {
        const key = `${entry.name}::${entry.absolutePath}`;
        if (seenAvailableSkills.has(key)) continue;
        seenAvailableSkills.add(key);
        availableSkills.push(entry);
      }
    }

    return {
      model: rawPayload.model || "",
      stream: rawPayload.stream ?? true,
      threadId: rawPayload.getThreadId(),
      turnId: rawPayload.getTurnId(),
      ...(systemInstructions && systemInstructions.length > 0 ? { systemInstructions } : {}),
      developerInstructions: developerInstructions.length > 0 ? developerInstructions : undefined,
      environmentContext: latestEnvFields ? this.formatEnvironmentFields(latestEnvFields) : undefined,
      ...(resolvedWorkspaceCwd ? { workspaceCwd: resolvedWorkspaceCwd } : {}),
      priorHistory,
      latestUserInstruction,
      trailingToolResults,
      tools,
      activeCodingTools,
      ...(deferredNamespaces.length > 0 ? { deferredNamespaces } : {}),
      executionPolicy,
      collaborationMode: this.detectCollaborationMode(rawPayload, input),
      rawSnapshot: rawPayload.toJSON(),
      images: images.length > 0 ? images : undefined,
      ...(availableSkills.length > 0 ? { availableSkills } : {}),
      ...(selectedSkills.length > 0 ? { selectedSkills } : {}),
    };
  }

  private static extractCollaborationModeFromControlText(text: string): "default" | "plan" | null {
    if (!text) return null;

    const tagRegex = /<collaboration_mode>([\s\S]*?)(?:<\/collaboration_mode>|$)/gi;
    const planRegex = /(?:#\s*Plan Mode|"mode"\s*:\s*"plan"|mode\s*=\s*"plan")/gi;
    const defaultRegex = /(?:#\s*Collaboration Mode:\s*Default|"mode"\s*:\s*"default"|mode\s*=\s*"default")/gi;

    let detected: "default" | "plan" | null = null;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = tagRegex.exec(text)) !== null) {
      const body = tagMatch[1] || "";

      planRegex.lastIndex = 0;
      let lastPlanIdx = -1;
      let match: RegExpExecArray | null;
      while ((match = planRegex.exec(body)) !== null) {
        lastPlanIdx = match.index;
      }

      defaultRegex.lastIndex = 0;
      let lastDefaultIdx = -1;
      while ((match = defaultRegex.exec(body)) !== null) {
        lastDefaultIdx = match.index;
      }

      if (lastPlanIdx !== -1 || lastDefaultIdx !== -1) {
        detected = lastPlanIdx > lastDefaultIdx ? "plan" : "default";
      }
    }

    return detected;
  }

  private static isCollaborationControlItem(item: CodexRawInputItem): boolean {
    const role = typeof (item as any).role === "string" ? (item as any).role : undefined;
    if (role === "developer" || role === "system") {
      return true;
    }

    const meta = (item as any).internal_chat_message_metadata_passthrough;
    const kinds = Array.isArray(meta?.content_item_kinds) ? meta.content_item_kinds : [];
    return kinds.includes("collaboration_mode.instructions");
  }

  /**
   * Phát hiện Collaboration Mode chỉ từ control-plane đáng tin cậy của Codex:
   * 1. Các message control (`role: "developer" | "system"` hoặc metadata `collaboration_mode.instructions`)
   *    chứa block `<collaboration_mode>...</collaboration_mode>` (lấy trạng thái xuất hiện cuối cùng).
   * 2. Hoặc trường cấu trúc `collaboration_mode` trên payload gốc.
   * Tuyệt đối bỏ qua `function_call_output`, `user`, `assistant` để tránh đọc nhầm code/log thành chuyển mode.
   */
  static detectCollaborationMode(
    rawPayload: CodexRawPayload,
    inputOverride?: CodexRawInputItem[],
  ): "default" | "plan" {
    const rawAny = rawPayload as any;
    const rawContextMsgs = rawAny.context?.messages || (rawPayload.extra as any)?.context?.messages;
    const resolvedInput: CodexRawInputItem[] = Array.isArray(inputOverride)
      ? inputOverride
      : (rawPayload.input && rawPayload.input.length > 0)
        ? rawPayload.input
        : (Array.isArray(rawContextMsgs) ? this.convertMessagesToInput(rawContextMsgs) : []);

    let latestControlMode: "default" | "plan" | null = null;
    for (const item of resolvedInput) {
      if (!item || !this.isCollaborationControlItem(item)) continue;
      const text = this.extractTextFromContent((item as any).content);
      const itemMode = this.extractCollaborationModeFromControlText(text);
      if (itemMode !== null) {
        latestControlMode = itemMode;
      }
    }

    if (latestControlMode === null && typeof rawAny.instructions === "string") {
      latestControlMode = this.extractCollaborationModeFromControlText(rawAny.instructions);
    }
    if (latestControlMode === null && typeof (rawPayload.extra as any)?.instructions === "string") {
      latestControlMode = this.extractCollaborationModeFromControlText((rawPayload.extra as any).instructions);
    }

    if (latestControlMode !== null) {
      return latestControlMode;
    }

    const structuredMode =
      rawAny.collaboration_mode ??
      (rawPayload.extra as any)?.collaboration_mode ??
      rawAny._rawBody?.collaboration_mode;

    if (typeof structuredMode === "string") {
      if (structuredMode.trim().toLowerCase() === "plan") return "plan";
      if (structuredMode.trim().toLowerCase() === "default") return "default";
    } else if (structuredMode && typeof structuredMode === "object") {
      const modeValue = typeof (structuredMode as any).mode === "string"
        ? (structuredMode as any).mode.trim().toLowerCase()
        : "";
      if (modeValue === "plan") return "plan";
      if (modeValue === "default") return "default";
    }

    return "default";
  }

  /**
   * Helper tìm kiếm tool theo tên từ request đã chuẩn hóa.
   * Xử lý xung đột namespace:
   * - Nếu truyền qualifiedName (vd: web.run), tìm chính xác.
   * - Nếu truyền short name (vd: run):
   *   + Nếu chỉ có duy nhất 1 tool có tên đó -> resolve thành công.
   *   + Nếu có từ 2 tool trở lên cùng mang short name -> trả về ambiguous (lỗi mơ hồ).
   */
  static resolveToolByName(
    tools: NormalizedTool[],
    targetName: string
  ): { tool: NormalizedTool | null; ambiguous?: boolean } {

    if (!targetName) return { tool: null };

    // Chuẩn hóa loại bỏ tiền tố functions. nếu có
    const cleanTarget = targetName.startsWith("functions.")
      ? targetName.slice("functions.".length)
      : targetName;

    // 1. Kiểm tra khớp chính xác qualifiedName (hỗ trợ cả namespace.name và namespace__name)
    const exactMatch = tools.find(t => {
      const underscoreName = t.identity.namespace
        ? `${t.identity.namespace}__${t.identity.name}`
        : t.identity.name;
      return (
        t.identity.qualifiedName === cleanTarget ||
        t.identity.qualifiedName === targetName ||
        underscoreName === cleanTarget ||
        underscoreName === targetName
      );
    });
    if (exactMatch) {
      return { tool: exactMatch };
    }

    // 2. Tìm theo short name (name)
    const shortMatches = tools.filter(t => t.identity.name === cleanTarget);
    if (shortMatches.length === 1) {
      return { tool: shortMatches[0] };
    }
    if (shortMatches.length > 1) {
      return { tool: null, ambiguous: true };
    }

    return { tool: null };
  }

  /**
   * Trích xuất và chuẩn hóa danh sách hình ảnh từ raw input hoặc context messages.
   */
  static extractImages(
    rawPayload: CodexRawPayload,
    options: CodexNormalizeOptions = {},
  ): NormalizedImageAttachment[] {
    const maxImages = options.maxImages ?? DEFAULT_MAX_INPUT_IMAGES;
    const imageRefPrefix = options.imageRefPrefix ?? "web-img";
    const images: NormalizedImageAttachment[] = [];
    const imageExtensions: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
    };

    const isDummy = (url: string) =>
      typeof url === "string" && (url.startsWith("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB") || url.length < 50);

    const processCandidate = (url?: unknown, detail?: unknown) => {
      if (typeof url !== "string" || !url.startsWith("data:") || isDummy(url)) return;
      const match = url.match(/^data:([^;,]+);base64,(.*)$/s);
      if (!match) return;
      const mediaType = match[1].toLowerCase();
      const ext = imageExtensions[mediaType] || "png";
      const base64 = match[2];
      try {
        const buf = Buffer.from(base64, "base64");
        if (buf.length === 0 || buf.length > 20_000_000) return;
        const idx = images.length + 1;
        images.push({
          ref: `${imageRefPrefix}-${idx}`,
          name: `image-${idx}.${ext}`,
          mimeType: mediaType,
          dataUrl: url,
          buffer: buf,
          ...(typeof detail === "string" ? { detail } : {}),
        });
      } catch {
        // bỏ qua nếu base64 không hợp lệ
      }
    };

    // 1. Quét từ rawPayload.input: CHỈ trích xuất ảnh thuộc về lượt hiện tại (sau assistant message gần nhất)
    const input = rawPayload.input || [];
    let lastAssistantIdx = -1;
    for (let i = input.length - 1; i >= 0; i--) {
      const it = input[i];
      if (
        it &&
        (it.role === "assistant" ||
          (it.type === "message" && (it as any).role === "assistant") ||
          it.type === "function_call" ||
          it.type === "custom_tool_call")
      ) {
        lastAssistantIdx = i;
        break;
      }
    }

    const currentTurnItems = lastAssistantIdx >= 0 ? input.slice(lastAssistantIdx + 1) : input;
    for (const item of currentTurnItems) {
      if (!item) continue;
      // Bóc tách ảnh từ tin nhắn user hoặc tool output (như view_image) ở lượt hiện tại
      const isToolOutput =
        item.type === "function_call_output" || item.type === "custom_tool_call_output";
      const isUser =
        item.role === "user" || (item.type === "message" && (item as any).role === "user") || !item.role;
      if (!isUser && !isToolOutput) continue;

      const content = isToolOutput ? (item as any).output : (item as any).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object") {
            if (block.type === "input_image" && block.image_url) {
              processCandidate(block.image_url, block.detail);
            } else if (block.type === "image" && block.imageUrl) {
              processCandidate(block.imageUrl, block.detail);
            }
          }
        }
      }
    }

    // 2. Quét từ context.messages nếu rawPayload.input không có ảnh
    if (images.length === 0) {
      const rawContextMsgs = (rawPayload as any).context?.messages || (rawPayload.extra as any)?.context?.messages;
      if (Array.isArray(rawContextMsgs) && rawContextMsgs.length > 0) {
        let lastAssistantMsgIdx = -1;
        for (let i = rawContextMsgs.length - 1; i >= 0; i--) {
          if (rawContextMsgs[i]?.role === "assistant") {
            lastAssistantMsgIdx = i;
            break;
          }
        }
        const currentMsgs = lastAssistantMsgIdx >= 0 ? rawContextMsgs.slice(lastAssistantMsgIdx + 1) : rawContextMsgs;
        for (const msg of currentMsgs) {
          if (!msg || msg.role !== "user") continue;
          const content = msg.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part === "object") {
                if (part.type === "image" && part.imageUrl) {
                  if (!images.some(img => img.dataUrl === part.imageUrl)) {
                    processCandidate(part.imageUrl, part.detail);
                  }
                }
              }
            }
          }
        }
      }
    }

    if (images.length > maxImages) {
      console.warn(
        `[web-normalizer] Số lượng ảnh trong lượt (${images.length}) vượt quá giới hạn ${maxImages}. Chỉ giữ lại ${maxImages} ảnh đầu tiên.`
      );
      return images.slice(0, maxImages);
    }

    return images;
  }
}
