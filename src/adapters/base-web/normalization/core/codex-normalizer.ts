import type {
  CodexRawToolSpec,
  CodexRawInputItem,
  CodexRawContentBlock,
} from "../dto/codex-raw-wire.dto";
import {
  DEFAULT_MAX_INPUT_IMAGES,
  type NormalizedCodexRequest,
  type NormalizedTool,
  type NormalizedToolResult,
  type NormalizedTurn,
  type NormalizedExecutionPolicy,
  type NormalizedImageAttachment,
} from "../dto/canonical-types.dto";
import type { CodexRawPayload } from "./codex-raw-payload";
import type {
  ICodexPayloadNormalizer,
  NormalizerOptions,
} from "../contracts/codex-normalizer.interface";

/**
 * Bộ chuẩn hóa dữ liệu yêu cầu Ingress từ Codex IDE sang Canonical Model.
 * Đóng vai trò là Canonical Boundary duy nhất cho toàn bộ downstream web adapters.
 */
export class CodexPayloadNormalizer implements ICodexPayloadNormalizer {
  public normalize(rawPayload: CodexRawPayload, options?: NormalizerOptions): NormalizedCodexRequest {
    return CodexPayloadNormalizer.normalize(rawPayload, options);
  }

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
    if (output === null || output === undefined) return "";
    if (typeof output === "string") return output;
    if (typeof output === "object") {
      try {
        return JSON.stringify(output, null, 2);
      } catch {
        return String(output);
      }
    }
    return String(output);
  }

  private static isInternalSystemMessage(item: CodexRawInputItem, text: string): boolean {
    const isExplicitSystem = item.role === "system";
    if (isExplicitSystem) return true;

    if (text.startsWith("<environment_context>") && text.endsWith("</environment_context>")) {
      return true;
    }

    if (
      text.includes("<collaboration_mode>") ||
      text.includes("<model_instructions>") ||
      text.includes("<developer_instructions>")
    ) {
      return true;
    }

    const lower = text.toLowerCase();
    const systemMarkers = [
      "# current app page",
      "# apps (connectors)",
      "# plugins",
      "deferred tool namespaces:",
      "open tabs / active files",
      "## terminal output",
      "directory listing of",
      "file tree for",
    ];

    return systemMarkers.some(marker => lower.includes(marker));
  }

  private static parseEnvironmentContext(rawContext: string): string {
    return rawContext.trim();
  }

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
      .replace(/<apps_instructions>[\s\S]*?<\/apps_instructions>/gi, "")
      .replace(/<plugins_instructions>[\s\S]*?<\/plugins_instructions>/gi, "")
      .replace(/<tools>[\s\S]*?<\/tools>/gi, "")
      .replace(/<\/?(?:collaboration_mode|apps_instructions|plugins_instructions|tools)>/gi, "")
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
        .replace(/# Plugins[\s\S]*?(?=\n# |\n\[|$)/i, "")
        .replace(/Deferred tool namespaces:[\s\S]*?(?=\n# |\n\[|$)/i, "")
        .trim();
    }

    return cleaned.trim();
  }

  static extractTools(rawPayload: CodexRawPayload): NormalizedTool[] {
    const tools: NormalizedTool[] = [];
    const seen = new Set<string>();
    const DEFAULT_FUNCTION_NAMESPACE = "functions";

    const processSpec = (spec: CodexRawToolSpec, namespace?: string) => {
      if (!spec || typeof spec !== "object") return;

      if (spec.type === "namespace" && Array.isArray(spec.tools)) {
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
        tools.push({
          kind: "function",
          identity,
          description,
          strict: (spec as any).strict,
          rawParameters: ((spec as any).parameters as Record<string, unknown>) || {},
        });
      }
    };

    if (Array.isArray(rawPayload.tools)) {
      for (const t of rawPayload.tools) {
        processSpec(t);
      }
    }

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

  static extractTrailingToolResults(rawPayload: CodexRawPayload): NormalizedToolResult[] {
    const input = rawPayload.input || [];
    const trailingResults: NormalizedToolResult[] = [];

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

      if (item.type === "compaction_trigger") {
        continue;
      }

      if (trailingResults.length > 0) {
        break;
      }

      if (item.type === "message" || item.type === "function_call" || item.type === "custom_tool_call") {
        break;
      }
    }

    return trailingResults;
  }

  static findLatestUserItemIndex(input: CodexRawInputItem[]): number {
    let fallbackIndex = -1;

    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (!item) continue;

      const isUserRole = item.role === "user" || (item.type === "message" && item.role === "user");
      if (!isUserRole) continue;

      const meta = (item as any).internal_chat_message_metadata_passthrough;
      const kinds = Array.isArray(meta?.content_item_kinds) ? ((meta.content_item_kinds as unknown[]) as string[]) : [];

      if (kinds.includes("user.text")) {
        return i;
      }

      if (fallbackIndex === -1) {
        fallbackIndex = i;
      }
    }

    return fallbackIndex;
  }

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

  static normalize(rawPayload: CodexRawPayload, options?: NormalizerOptions): NormalizedCodexRequest {
    const rawContextMsgs = (rawPayload as any).context?.messages || (rawPayload.extra as any)?.context?.messages;
    const input = (rawPayload.input && rawPayload.input.length > 0)
      ? rawPayload.input
      : (Array.isArray(rawContextMsgs) ? this.convertMessagesToInput(rawContextMsgs) : []);

    const tools = this.extractTools(rawPayload);
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

    const trailingToolResults = this.extractTrailingToolResults({ ...rawPayload, input } as any);
    const latestUserIdx = this.findLatestUserItemIndex(input);
    let latestUserInstruction: string | undefined;
    if (latestUserIdx !== -1) {
      const text = this.extractTextFromContent((input[latestUserIdx] as any).content);
      if (text.trim()) {
        latestUserInstruction = text.trim();
      }
    }

    const developerInstructions: string[] = [];
    let environmentContext: string | undefined;

    const priorHistory: NormalizedTurn[] = [];
    for (let i = 0; i < input.length; i++) {
      if (i === latestUserIdx) {
        continue;
      }

      const item = input[i];
      if (!item) continue;

      let text = "";
      if (item.type === "message" || (!item.type && (item.role === "user" || item.role === "developer" || item.role === "assistant"))) {
        text = this.extractTextFromContent((item as any).content);
      }

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

    const filteredTools: Array<{ tool: NormalizedTool; reason: string }> = [];
    const activeCodingTools: NormalizedTool[] = [];

    for (const tool of tools) {
      if (!tool.identity.name || tool.identity.name.trim() === "") {
        filteredTools.push({
          tool,
          reason: "Tên công cụ bị rỗng hoặc không xác định",
        });
        continue;
      }

      activeCodingTools.push(tool);
    }

    console.log(
      `[normalizer]\ntotalTools=${tools.length}\nactiveTools=${activeCodingTools.length}\nfilteredTools=${filteredTools.length}`
    );

    const executionPolicy: NormalizedExecutionPolicy = {
      parallelToolCalls: rawPayload.parallel_tool_calls ?? false,
      toolChoice: rawPayload.tool_choice,
    };

    const images = this.extractImages(rawPayload, options?.maxInputImages ?? DEFAULT_MAX_INPUT_IMAGES);

    return {
      model: rawPayload.model || options?.defaultModel || "web-chat/default",
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

  static detectCollaborationMode(rawPayload: CodexRawPayload): "default" | "plan" {
    const rawString = typeof (rawPayload as any).toJSON === "function"
      ? JSON.stringify((rawPayload as any).toJSON())
      : JSON.stringify(rawPayload);

    const planRegex = /(?:<collaboration_mode>#\s*Plan Mode|"mode"\s*:\s*"plan")/gi;
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

  static resolveToolByName(
    tools: NormalizedTool[],
    targetName: string
  ): { tool: NormalizedTool | null; ambiguous?: boolean } {
    if (!targetName) return { tool: null };

    const cleanTarget = targetName.startsWith("functions.")
      ? targetName.slice("functions.".length)
      : targetName;

    const exactMatch = tools.find(t => t.identity.qualifiedName === cleanTarget || t.identity.qualifiedName === targetName);
    if (exactMatch) {
      return { tool: exactMatch };
    }

    const shortMatches = tools.filter(t => t.identity.name === cleanTarget);
    if (shortMatches.length === 1) {
      return { tool: shortMatches[0] };
    }
    if (shortMatches.length > 1) {
      return { tool: null, ambiguous: true };
    }

    return { tool: null };
  }

  static extractImages(rawPayload: CodexRawPayload, maxImages = DEFAULT_MAX_INPUT_IMAGES, prefix = "m365-img"): NormalizedImageAttachment[] {
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
          ref: `${prefix}-${idx}`,
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
        `[normalizer] Số lượng ảnh trong lượt (${images.length}) vượt quá giới hạn ${maxImages}. Chỉ giữ lại ${maxImages} ảnh đầu tiên.`
      );
      return images.slice(0, maxImages);
    }

    return images;
  }
}
