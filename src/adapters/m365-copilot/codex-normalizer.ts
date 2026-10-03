import type {
  CodexRawPayload,
  CodexRawToolSpec,
  CodexRawInputItem,
  CodexRawContentBlock,
} from "./codex-raw-payload";
import type {
  NormalizedCodexRequest,
  NormalizedTool,
  NormalizedToolResult,
  NormalizedTurn,
  NormalizedExecutionPolicy,
} from "./canonical-types";

export class CodexPayloadNormalizer {
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

  private static stringifyToolOutput(output: unknown): string {
    if (typeof output === "string") return output;
    const serialized = JSON.stringify(output ?? "");
    return serialized ?? "";
  }

  /**
   * Chuẩn hóa toàn bộ danh sách công cụ từ root tools và additional_tools trong input.
   * Bảo toàn namespace, qualifiedName, và lưu trữ rawParameters/format nguyên vẹn.
   */
  static extractTools(rawPayload: CodexRawPayload): NormalizedTool[] {
    const tools: NormalizedTool[] = [];
    const seen = new Set<string>();

    const processSpec = (spec: CodexRawToolSpec, namespace?: string) => {
      if (!spec || typeof spec !== "object") return;

      if (spec.type === "namespace" && Array.isArray(spec.tools)) {
        const nextNs = namespace ? `${namespace}.${spec.name}` : spec.name;
        for (const sub of spec.tools) {
          processSpec(sub, nextNs);
        }
        return;
      }

      const name = spec.name;
      if (!name || typeof name !== "string") return;

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

    // 2. Quét từ additional_tools trong input
    if (Array.isArray(rawPayload.input)) {
      for (const item of rawPayload.input) {
        if (item && item.type === "additional_tools" && Array.isArray(item.tools)) {
          for (const t of item.tools) {
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
   * - Thu thập các function_call_output hoặc custom_tool_call_output.
   * - Bỏ qua các control item trong suốt (như compaction_trigger).
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

      // Bỏ qua các control items trong suốt không làm đứt trailing group
      if (item.type === "compaction_trigger") {
        continue;
      }

      // Nếu đã thu thập được tool output và gặp item khác (như message hoặc turn boundary trước) -> dừng lại
      if (trailingResults.length > 0) {
        break;
      }

      // Nếu gặp message hoặc turn boundary trước khi tìm thấy bất kỳ tool output nào -> không có trailing tool results
      if (item.type === "message" || item.type === "function_call" || item.type === "custom_tool_call") {
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
   * Chuẩn hóa toàn bộ request từ CodexRawPayload sang NormalizedCodexRequest.
   */
  static normalize(rawPayload: CodexRawPayload): NormalizedCodexRequest {
    const input = rawPayload.input || [];
    const tools = this.extractTools(rawPayload);
    const trailingToolResults = this.extractTrailingToolResults(rawPayload);

    // Xác định latest user message
    const latestUserIdx = this.findLatestUserItemIndex(input);
    let latestUserInstruction: string | undefined;
    if (latestUserIdx !== -1) {
      const text = this.extractTextFromContent((input[latestUserIdx] as any).content);
      if (text.trim()) {
        latestUserInstruction = text.trim();
      }
    }

    // Xây dựng priorHistory: LOẠI BỎ hoàn toàn latest user item để tránh duplicate trong prompt!
    const priorHistory: NormalizedTurn[] = [];
    for (let i = 0; i < input.length; i++) {
      if (i === latestUserIdx) {
        // Bỏ qua item người dùng mới nhất, vì nó sẽ được render riêng ở cuối prompt
        continue;
      }

      const item = input[i];
      if (!item) continue;

      if (item.type === "message" || (!item.type && (item.role === "user" || item.role === "assistant" || item.role === "developer"))) {
        const text = this.extractTextFromContent((item as any).content);
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
      } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        priorHistory.push({
          role: "tool",
          content: this.stringifyToolOutput(item.output),
          callId: String(item.call_id || ""),
        });
      }
    }

    // Lọc activeCodingTools: chỉ chọn các tool mà turn hiện tại THỰC SỰ khai báo
    const preferredToolNames = new Set([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
    ]);

    const activeCodingTools = tools.filter(t => preferredToolNames.has(t.identity.name));

    const executionPolicy: NormalizedExecutionPolicy = {
      parallelToolCalls: rawPayload.parallel_tool_calls ?? false,
      toolChoice: rawPayload.tool_choice,
    };

    return {
      model: rawPayload.model || "m365-copilot/think",
      stream: rawPayload.stream ?? true,
      threadId: rawPayload.getThreadId(),
      turnId: rawPayload.getTurnId(),
      priorHistory,
      latestUserInstruction,
      trailingToolResults,
      tools,
      activeCodingTools,
      executionPolicy,
      rawSnapshot: rawPayload.toJSON(),
    };
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

    // 1. Kiểm tra khớp chính xác qualifiedName trước
    const exactMatch = tools.find(t => t.identity.qualifiedName === targetName);
    if (exactMatch) {
      return { tool: exactMatch };
    }

    // 2. Nếu targetName không có namespace (không chứa dấu chấm), tìm theo short name
    const shortMatches = tools.filter(t => t.identity.name === targetName);
    if (shortMatches.length === 1) {
      return { tool: shortMatches[0] };
    }
    if (shortMatches.length > 1) {
      return { tool: null, ambiguous: true };
    }

    return { tool: null };
  }
}
