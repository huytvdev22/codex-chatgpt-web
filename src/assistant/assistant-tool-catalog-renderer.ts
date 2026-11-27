import type { NormalizedTool } from "../adapters/web/normalization/canonical-types";
import type { McpToolDeltaOptions } from "../adapters/web/prompt/mcp-tool-catalog-renderer";
import {
  INTERNAL_TOOL_DESCRIBE_NAME,
  WebToolRegistry,
  type McpToolFullSpec,
} from "../adapters/web/tools/web-tool-registry";

/**
 * Các tool nội bộ đặc thù Codex IDE không phù hợp hoặc không cần xuất hiện ở Turn 1 của Telegram Bot.
 * (Vẫn hợp lệ ở tầng validation nếu hiếm khi được gọi.)
 */
const HIDDEN_ASSISTANT_TOOLS = new Set([
  "get_goal",
  "create_goal",
  "update_goal",
]);

/**
 * Bộ tham số cốt lõi cho `exec_command` giúp giảm ~70% dung lượng JSON ở Turn 1
 * nhưng vẫn giữ đủ `sandbox_permissions` & `justification` để xin quyền duyệt trên Telegram.
 */
const EXEC_COMMAND_ESSENTIAL_PARAMS = new Set([
  "cmd",
  "workdir",
  "sandbox_permissions",
  "justification",
]);

/**
 * Tập tool cốt lõi in chữ ký tham số rút gọn ngay ở Turn 1 của Trợ lý cá nhân.
 * `write_stdin` được đẩy xuống `extended` để giữ Turn 1 nhẹ tối đa.
 */
const ASSISTANT_CORE_TOOLS = new Set([
  "exec_command",
  "apply_patch",
  "request_user_input",
  "view_image",
  "tool_search",
  "read_file",
  "list_dir",
  "search_files",
  "grep_code",
]);

export interface AssistantInitialCatalogOptions {
  tools: NormalizedTool[];
  deferredNamespaces?: string[];
}

function formatCompactParamSignature(
  tool: NormalizedTool,
  allowedParams?: ReadonlySet<string>,
): string {
  if (tool.kind === "custom") {
    return tool.identity.name === "apply_patch"
      ? "(raw *** Begin Patch ... *** End Patch)"
      : "(raw text)";
  }

  const rawParams = tool.rawParameters || {};
  const props =
    rawParams.properties &&
    typeof rawParams.properties === "object" &&
    !Array.isArray(rawParams.properties)
      ? (rawParams.properties as Record<string, unknown>)
      : {};
  const required = new Set(
    Array.isArray(rawParams.required) ? rawParams.required.map(String) : [],
  );

  const entries: string[] = [];
  for (const [key, rawProp] of Object.entries(props)) {
    if (allowedParams && !allowedParams.has(key)) continue;
    const prop =
      rawProp && typeof rawProp === "object" && !Array.isArray(rawProp)
        ? (rawProp as Record<string, unknown>)
        : {};
    let typeLabel = typeof prop.type === "string" ? prop.type : "any";
    if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.length <= 4) {
      typeLabel = prop.enum.map((v) => JSON.stringify(v)).join("|");
    }
    const suffix = required.has(key) ? "" : "?";
    entries.push(`${key}${suffix}:${typeLabel}`);
  }
  return `(${entries.join(", ")})`;
}

function compactShortDescription(tool: NormalizedTool): string {
  const wireName = tool.identity.qualifiedName || tool.identity.name;
  if (wireName === "exec_command") {
    return "Chạy lệnh shell cục bộ (dùng sandbox_permissions=\"require_escalated\" + justification nếu cần quyền ngoài workspace).";
  }
  if (wireName === "apply_patch") {
    return "Tạo/sửa 1 tệp bằng raw patch trong <custom_tool_call name=\"apply_patch\">.";
  }
  if (wireName === "request_user_input") {
    return "Mở nút lựa chọn / hỏi thêm người dùng trên Telegram.";
  }
  if (wireName === "tool_search") {
    return "Mở khóa nhóm tool trong deferred_namespaces trước khi gọi.";
  }
  if (wireName === "view_image") {
    return "Đọc ảnh cục bộ để kiểm tra trực quan.";
  }
  const base = WebToolRegistry.getCuratedDescription(tool, true);
  return base.length > 110 ? `${base.slice(0, 109).trimEnd()}…` : base;
}

/**
 * Trình render danh mục công cụ tối giản dành riêng cho Trợ lý cá nhân (`src/assistant/`):
 * - Cắt bỏ schema dài dòng của `exec_command` / `write_stdin` (~65–70% nhẹ hơn `McpToolCatalogRenderer`).
 * - Ẩn tool rác đặc thù IDE (`*_goal`), giữ nguyên tương thích `tools.describe` & `tool_search`.
 */
export class AssistantToolCatalogRenderer {
  public renderInitialCatalog(options: AssistantInitialCatalogOptions): string {
    const { tools, deferredNamespaces = [] } = options;
    const visibleTools = tools.filter((tool) => {
      const name = tool.identity.name;
      if (tool.identity.namespace && /^multi_agent_v1\b/i.test(tool.identity.namespace)) {
        return false;
      }
      return !HIDDEN_ASSISTANT_TOOLS.has(name);
    });

    if (visibleTools.length === 0 && deferredNamespaces.length === 0) {
      return "";
    }

    const coreTools: NormalizedTool[] = [];
    const extendedTools: NormalizedTool[] = [];
    for (const tool of visibleTools) {
      const wireName = tool.identity.qualifiedName || tool.identity.name;
      const isCore =
        (!tool.identity.namespace && ASSISTANT_CORE_TOOLS.has(tool.identity.name)) ||
        ASSISTANT_CORE_TOOLS.has(wireName) ||
        wireName.includes("telegram_send_");
      if (isCore) coreTools.push(tool);
      else extendedTools.push(tool);
    }

    const lines: string[] = ["[TOOL CATALOG]"];
    for (const tool of coreTools) {
      const wireName = tool.identity.qualifiedName || tool.identity.name;
      const allowedParams =
        wireName === "exec_command" ? EXEC_COMMAND_ESSENTIAL_PARAMS : undefined;
      const sig = formatCompactParamSignature(tool, allowedParams);
      lines.push(`- ${wireName}${sig}: ${compactShortDescription(tool)}`);
    }

    if (extendedTools.length > 0) {
      const names = extendedTools
        .map((t) => t.identity.qualifiedName || t.identity.name)
        .join(", ");
      lines.push(
        `- Công cụ phụ (gọi ${INTERNAL_TOOL_DESCRIBE_NAME}({"names":[...]}) nếu cần schema): ${names}`,
      );
    }

    const cleanDeferred = deferredNamespaces
      .map((entry) => entry.trim())
      .filter((entry) => entry && !/^multi_agent_v1\b/i.test(entry));
    if (cleanDeferred.length > 0) {
      lines.push(
        `- Deferred (gọi tool_search trước khi dùng): ${cleanDeferred.join("; ")}`,
      );
    }

    return lines.join("\n");
  }

  public renderToolDelta(options: McpToolDeltaOptions): string {
    const {
      currentTools,
      addedTools = [],
      removedToolNames = [],
      failedToolName,
      failedErrorCode,
      failedErrorMessage,
    } = options;

    const correctionSpecs: McpToolFullSpec[] = [];
    if (failedToolName) {
      const matched = WebToolRegistry.describeTools([failedToolName], currentTools).found;
      for (const item of matched) {
        if (!correctionSpecs.some((existing) => existing.name === item.name)) {
          correctionSpecs.push(item);
        }
      }
    }

    const filteredAdded = addedTools.filter(
      (t) =>
        !HIDDEN_ASSISTANT_TOOLS.has(t.identity.name) &&
        !(t.identity.namespace && /^multi_agent_v1\b/i.test(t.identity.namespace)),
    );
    if (
      filteredAdded.length === 0 &&
      removedToolNames.length === 0 &&
      correctionSpecs.length === 0 &&
      !failedErrorMessage
    ) {
      return "";
    }

    const lines: string[] = [
      failedToolName
        ? `[TOOL SCHEMA FIX: ${failedErrorCode || "ERROR"}]`
        : "[TOOL DELTA]",
    ];
    if (failedErrorMessage) {
      lines.push(failedErrorMessage);
    }
    for (const tool of filteredAdded) {
      const wireName = tool.identity.qualifiedName || tool.identity.name;
      lines.push(
        `+ ${wireName}${formatCompactParamSignature(tool)}: ${compactShortDescription(tool)}`,
      );
    }
    if (removedToolNames.length > 0) {
      lines.push(`- Đã gỡ: ${removedToolNames.join(", ")}`);
    }
    if (correctionSpecs.length > 0) {
      lines.push("```json", JSON.stringify(correctionSpecs), "```");
    }
    return lines.join("\n");
  }
}

export const assistantToolCatalogRenderer = new AssistantToolCatalogRenderer();
