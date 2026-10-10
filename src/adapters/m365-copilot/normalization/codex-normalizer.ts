
import type {
  CodexRawPayload,
  CodexRawToolSpec,
  CodexRawInputItem,
  CodexRawContentBlock,
} from "./codex-raw-payload";
import {
  M365_MAX_INPUT_IMAGES,
  type NormalizedCodexRequest,
  type NormalizedTool,
  type NormalizedToolResult,
  type NormalizedTurn,
  type NormalizedExecutionPolicy,
  type NormalizedImageAttachment,
} from "./canonical-types";

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
   */
  private static stringifyToolOutput(output: unknown): string {

    if (typeof output === "string") return output;
    const serialized = JSON.stringify(output ?? "");
    return serialized ?? "";
  }

  /**
   * Định dạng thông tin môi trường làm việc gọn gàng, loại bỏ toàn bộ XML rác của macOS seatbelt sandbox.
   */
  private static parseEnvironmentContext(rawEnv: string): string {
    const cwd = rawEnv.match(/<cwd>([\s\S]*?)<\/cwd>/i)?.[1]?.trim();
    const shell = rawEnv.match(/<shell>([\s\S]*?)<\/shell>/i)?.[1]?.trim();
    const date = rawEnv.match(/<current_date>([\s\S]*?)<\/current_date>/i)?.[1]?.trim();
    const tz = rawEnv.match(/<timezone>([\s\S]*?)<\/timezone>/i)?.[1]?.trim();
    const ws = rawEnv.match(/<workspace_roots>[\s\S]*?<root>([\s\S]*?)<\/root>/i)?.[1]?.trim();

    const parts: string[] = [];
    if (cwd) parts.push(`- Thư mục làm việc (cwd): ${cwd}`);
    if (shell) parts.push(`- Shell: ${shell}`);
    if (date || tz) parts.push(`- Thời gian: ${date || ""} (${tz || ""})`.trim());
    if (ws && ws !== cwd) parts.push(`- Workspace: ${ws}`);

    return parts.length > 0 ? parts.join("\n") : rawEnv.trim();
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
      trimmed.startsWith("<recommended_plugins>") ||
      trimmed.startsWith("<skills_instructions>") ||
      trimmed.startsWith("<permissions") ||
      trimmed.startsWith("<collaboration_mode>")
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
    let cleaned = text
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
      .replace(/<codex_apps_client_time_context>[\s\S]*?<\/codex_apps_client_time_context>/gi, "")
      .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/gi, "")
      .replace(/<codex_apps_open_page_instructions>[\s\S]*?<\/codex_apps_open_page_instructions>/gi, "")
      .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, "")
      .replace(/<permissions[\s\S]*?<\/permissions[^>]*>/gi, "")
      .replace(/<permissions\s+instructions>[\s\S]*?<\/permissions\s+instructions>/gi, "")
      .replace(/<sandbox[\s\S]*?<\/sandbox[^>]*>/gi, "")
      .replace(/<sandbox_mode[\s\S]*?<\/sandbox_mode[^>]*>/gi, "")
      .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, "")
      .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, "")
      .replace(/`?\s*change it;\s*user requests or tool descriptions[\s\S]*?(?=\n# |\n<|$|\n\n)/gi, "")
      .replace(/##\s*request_user_input availability[\s\S]*?(?=\n# |\n<|$|\n\n)/gi, "")
      .replace(/In Default mode, strongly prefer making reasonable assumptions[\s\S]*?(?=\n# |\n<|$|\n\n)/gi, "")
      .replace(/Known mode names are Default and Plan\.?/gi, "")
      .replace(/¨C[a-zA-Z0-9_-]+C/g, "")
      .trim();

    const isCodexBuiltInBoilerplate =
      cleaned.includes("You are Codex") ||
      cleaned.includes("# Rules for getting work done") ||
      cleaned.includes("# Personality\nAs Codex") ||
      cleaned.includes("Exercise caution when escaping text for execcommand calls");

    if (isCodexBuiltInBoilerplate) {
      cleaned = cleaned
        .replace(/You are Codex[\s\S]*?(?=\n# |\n\[|$)/i, "")
        .replace(/# Personality[\s\S]*?(?=\n# |\n\[|$)/i, "")
        .replace(/# When to ask the user for permission[\s\S]*?(?=\n# |\n\[|$)/i, "")
        .replace(/# Autonomy and persistence[\s\S]*?(?=\n# |\n\[|$)/i, "")
        .replace(/# Working with the user[\s\S]*?(?=\n# |\n\[|$)/i, "")
        .replace(/# Rules for getting work done(?:\n(?:\s*[-*]|\s{2,}).*)*(?=\n# |\n\[|\n<|\n[^\s\-*]|$)/gi, "")
        .replace(/# Rules for getting work done[\s\S]*?(?=\n# |\n\[|$)/i, "")
        .replace(/# Using skills[\s\S]*?(?=\n# |\n\[|$)/i, "")
        .replace(/# Apps \(Connectors\)[\s\S]*?(?=\n# |\n\[|$)/i, "")
        .trim();
    }

    return cleaned.trim();
  }

  /**
   * Chuẩn hóa toàn bộ danh sách công cụ từ root tools và additional_tools trong input.
   * Bảo toàn namespace, qualifiedName, và lưu trữ rawParameters/format nguyên vẹn.
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
  static normalize(rawPayload: CodexRawPayload): NormalizedCodexRequest {

    const rawContextMsgs = (rawPayload as any).context?.messages || (rawPayload.extra as any)?.context?.messages;
    const input = (rawPayload.input && rawPayload.input.length > 0)
      ? rawPayload.input
      : (Array.isArray(rawContextMsgs) ? this.convertMessagesToInput(rawContextMsgs) : []);

    const tools = this.extractTools(rawPayload);
    // Nếu tools rỗng nhưng có context.tools, bổ sung từ context.tools
    const rawContextTools = (rawPayload as any).context?.tools || (rawPayload.extra as any)?.context?.tools;
    if (tools.length === 0 && Array.isArray(rawContextTools)) {
      for (const t of rawContextTools) {
        if (t && t.name) {
          tools.push({
            kind: "function",
            identity: { name: t.name, qualifiedName: t.name },
            description: t.description || "",
            rawParameters: t.parameters || {},
          });
        }
      }
    }

    // Ghép call_id cho trailing tool results nếu input đến từ context.messages
    const trailingToolResults = this.extractTrailingToolResults({ ...rawPayload, input } as any);

    // Xác định latest user message
    const latestUserIdx = this.findLatestUserItemIndex(input);
    let latestUserInstruction: string | undefined;
    if (latestUserIdx !== -1) {
      const text = this.extractTextFromContent((input[latestUserIdx] as any).content);
      if (text.trim()) {
        latestUserInstruction = text.trim();
      }
    }

    // Trích xuất developerInstructions và environmentContext từ input
    const developerInstructions: string[] = [];
    let environmentContext: string | undefined;

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
      }

      // Trích xuất environmentContext nếu có trong bất kỳ message nào (kể cả user hay developer)
      const envMatch = text.match(/<environment_context>([\s\S]*?)<\/environment_context>/i);
      if (envMatch) {
        environmentContext = (environmentContext ? `${environmentContext}\n` : "") + this.parseEnvironmentContext(envMatch[1]);
      }

      const isDev = item.role === "developer" || (item.type === "message" && item.role === "developer");
      if (isDev) {
        const cleaned = this.cleanDeveloperInstructions(text);
        if (cleaned && cleaned.length > 5 && !cleaned.includes("You are Codex")) {
          developerInstructions.push(cleaned);
        }
        continue;
      }

      // LOẠI BỎ TRIỆT ĐỂ: Nếu là tin nhắn hệ thống nội bộ của Codex (environment, app page, time context, plugins...)
      // Tuyệt đối không đưa vào priorHistory để tránh làm ô nhiễm lịch sử trò chuyện của người dùng!
      if (this.isInternalSystemMessage(item, text)) {
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
      } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        priorHistory.push({
          role: "tool",
          content: this.stringifyToolOutput(item.output),
          callId: String(item.call_id || ""),
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

    const images = this.extractImages(rawPayload);

    return {
      model: rawPayload.model || "m365-copilot/think",
      stream: rawPayload.stream ?? true,
      threadId: rawPayload.getThreadId(),
      turnId: rawPayload.getTurnId(),
      developerInstructions: developerInstructions.length > 0 ? developerInstructions : undefined,
      environmentContext,
      priorHistory,
      latestUserInstruction,
      trailingToolResults,
      tools,
      activeCodingTools,
      executionPolicy,
      collaborationMode: this.detectCollaborationMode(rawPayload),
      rawSnapshot: rawPayload.toJSON(),
      images: images.length > 0 ? images : undefined,
    };
  }

  /**
   * Phát hiện Collaboration Mode trực tiếp từ raw request của Codex:
   * - Nếu chứa: <collaboration_mode># Plan Mode (Conversational) -> "plan"
   * - Nếu không bật: <collaboration_mode># Collaboration Mode: Default -> "default"
   * (So sánh vị trí xuất hiện cuối cùng trong request để phản ánh trạng thái mới nhất).
   */
  static detectCollaborationMode(rawPayload: CodexRawPayload): "default" | "plan" {

    const rawString = typeof (rawPayload as any).toJSON === "function"
      ? JSON.stringify((rawPayload as any).toJSON())
      : JSON.stringify(rawPayload);

    // Marker bật Plan Mode:
    // - <collaboration_mode># Plan Mode (Conversational) từ Codex thực tế
    // - hoặc các biến thể <collaboration_mode># Plan Mode, "mode":"plan"
    const planRegex = /(?:<collaboration_mode>#\s*Plan Mode|"mode"\s*:\s*"plan")/gi;
    // Marker Default Mode (không bật Plan):
    // - <collaboration_mode># Collaboration Mode: Default
    // - hoặc "mode":"default"
    const defaultRegex = /(?:<collaboration_mode>#\s*Collaboration Mode:\s*Default|"mode"\s*:\s*"default")/gi;

    let lastPlanIdx = -1;
    let match: RegExpExecArray | null;
    while ((match = planRegex.exec(rawString)) !== null) {
      lastPlanIdx = match.index;
    }

    let lastDefaultIdx = -1;
    while ((match = defaultRegex.exec(rawString)) !== null) {
      lastDefaultIdx = match.index;
    }

    if (lastPlanIdx !== -1 && lastPlanIdx > lastDefaultIdx) {
      return "plan";
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

    // 1. Kiểm tra khớp chính xác qualifiedName trước
    const exactMatch = tools.find(t => t.identity.qualifiedName === cleanTarget || t.identity.qualifiedName === targetName);
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
  static extractImages(rawPayload: CodexRawPayload): NormalizedImageAttachment[] {
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
          ref: `m365-img-${idx}`,
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
      // Chỉ bóc tách ảnh từ tin nhắn của người dùng ở lượt hiện tại
      const isUser = item.role === "user" || (item.type === "message" && (item as any).role === "user") || !item.role;
      if (!isUser) continue;

      const content = (item as any).content;
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

    if (images.length > M365_MAX_INPUT_IMAGES) {
      console.warn(
        `[m365-normalizer] Số lượng ảnh trong lượt (${images.length}) vượt quá giới hạn ${M365_MAX_INPUT_IMAGES} của M365 Copilot. Chỉ giữ lại ${M365_MAX_INPUT_IMAGES} ảnh đầu tiên.`
      );
      return images.slice(0, M365_MAX_INPUT_IMAGES);
    }

    return images;
  }
}
