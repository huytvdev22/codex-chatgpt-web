import type { NormalizedTool } from "../normalization/canonical-types";
import {
  INTERNAL_TOOL_DESCRIBE_NAME,
  WebToolRegistry,
  type McpToolFullSpec,
} from "../tools/web-tool-registry";

export interface McpInitialCatalogOptions {
  tools: NormalizedTool[];
  deferredNamespaces?: string[];
  assistantName?: string;
}

export interface McpToolDeltaOptions {
  currentTools: NormalizedTool[];
  addedTools?: NormalizedTool[];
  removedToolNames?: string[];
  failedToolName?: string;
  failedErrorCode?: string;
  failedErrorMessage?: string;
}

const MAX_PARAM_DESC_CHARS = 120;

function compactInputSchema(rawParameters: Record<string, unknown>): Record<string, unknown> {
  const propertiesRaw =
    rawParameters.properties &&
    typeof rawParameters.properties === "object" &&
    !Array.isArray(rawParameters.properties)
      ? (rawParameters.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(rawParameters.required)
    ? rawParameters.required.map(String)
    : [];

  const compactProps: Record<string, unknown> = {};
  for (const [key, rawProp] of Object.entries(propertiesRaw)) {
    if (!rawProp || typeof rawProp !== "object" || Array.isArray(rawProp)) {
      compactProps[key] = { type: "unknown" };
      continue;
    }
    const prop = rawProp as Record<string, unknown>;
    const entry: Record<string, unknown> = {};
    if (prop.type !== undefined) entry.type = prop.type;
    if (Array.isArray(prop.enum) && prop.enum.length > 0) entry.enum = prop.enum;
    if (prop.items && typeof prop.items === "object" && !Array.isArray(prop.items)) {
      const itemType = (prop.items as Record<string, unknown>).type;
      if (itemType !== undefined) entry.items = { type: itemType };
    }
    if (typeof prop.description === "string" && prop.description.trim().length > 0) {
      const cleaned = prop.description.replace(/\s+/g, " ").trim();
      entry.description =
        cleaned.length > MAX_PARAM_DESC_CHARS
          ? `${cleaned.slice(0, MAX_PARAM_DESC_CHARS).trimEnd()}…`
          : cleaned;
    }
    compactProps[key] = entry;
  }

  return {
    type: "object",
    properties: compactProps,
    ...(required.length > 0 ? { required } : {}),
  };
}

function buildCompactCoreSpec(tool: NormalizedTool): Record<string, unknown> {
  const wireName = tool.identity.qualifiedName || tool.identity.name;
  const description = WebToolRegistry.getCuratedDescription(tool, true);

  if (tool.kind === "custom") {
    return {
      name: wireName,
      kind: "custom",
      description,
      inputFormat:
        wireName === "apply_patch"
          ? "raw *** Begin Patch ... *** End Patch inside <custom_tool_call name=\"apply_patch\">"
          : "raw freeform text",
    };
  }

  return {
    name: wireName,
    kind: "function",
    ...(tool.identity.namespace ? { namespace: tool.identity.namespace } : {}),
    description,
    inputSchema: compactInputSchema(tool.rawParameters || {}),
  };
}

function buildCatalogLineSpec(tool: NormalizedTool): Record<string, unknown> {
  const wireName = tool.identity.qualifiedName || tool.identity.name;
  return {
    name: wireName,
    kind: tool.kind,
    ...(tool.identity.namespace ? { namespace: tool.identity.namespace } : {}),
    description: WebToolRegistry.getCuratedDescription(tool, true),
  };
}

/**
 * Render danh sách tool theo chuẩn MCP JSON Catalog 2 tầng:
 * - Turn 1: `core_tools` có inline compact inputSchema; `extended_catalog` chỉ 1 dòng tóm tắt
 *   kèm meta-tool `tools.describe` để tra cứu full inputSchema khi cần.
 * - Turn 2+: Chỉ render `[MCP TOOL DELTA]` khi danh sách tool thay đổi hoặc có lỗi schema.
 */
export class McpToolCatalogRenderer {
  renderInitialCatalog(options: McpInitialCatalogOptions): string {
    const { tools, deferredNamespaces = [], assistantName = "trợ lý web" } = options;

    if (tools.length === 0) {
      return "[MCP TOOL CATALOG]\nHiện không có công cụ nào khả dụng ở lượt này.";
    }

    const coreTools = tools.filter(tool => WebToolRegistry.getTier(tool) === "core");
    const extendedTools = tools.filter(tool => WebToolRegistry.getTier(tool) === "extended");

    const catalogPayload: Record<string, unknown> = {
      core_tools: coreTools.map(buildCompactCoreSpec),
    };

    if (extendedTools.length > 0) {
      catalogPayload.extended_catalog = extendedTools.map(buildCatalogLineSpec);
      catalogPayload.lookup_tool = {
        name: INTERNAL_TOOL_DESCRIBE_NAME,
        kind: "function",
        description:
          "Tra cứu full MCP JSON Schema cho các tool trong extended_catalog (trả kết quả nội bộ ngay trước khi gọi tool).",
        inputSchema: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "Danh sách tên tool cần xem schema chi tiết.",
            },
          },
          required: ["names"],
        },
      };
    }

    if (deferredNamespaces.length > 0) {
      catalogPayload.deferred_namespaces = deferredNamespaces;
    }

    const lines: string[] = [
      "[MCP TOOL CATALOG]",
      `- Chỉ gọi đúng tên tool có trong catalog bên dưới; không dùng web search hay python nội bộ của ${assistantName}.`,
    ];
    if (extendedTools.length > 0) {
      lines.push(
        `- Với tool trong \`extended_catalog\`, gọi \`${INTERNAL_TOOL_DESCRIBE_NAME}\` trước nếu bạn chưa chắc schema tham số.`,
      );
    }
    if (deferredNamespaces.length > 0) {
      lines.push(
        "- Với nhóm trong `deferred_namespaces`, gọi `tool_search` để mở khóa rồi dùng.",
      );
    }

    lines.push("", "```json", JSON.stringify(catalogPayload, null, 2), "```");
    return lines.join("\n");
  }

  renderToolDelta(options: McpToolDeltaOptions): string {
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
        if (!correctionSpecs.some(existing => existing.name === item.name)) {
          correctionSpecs.push(item);
        }
      }
    }

    if (
      addedTools.length === 0 &&
      removedToolNames.length === 0 &&
      correctionSpecs.length === 0 &&
      !failedErrorMessage
    ) {
      return "";
    }

    const deltaPayload: Record<string, unknown> = {};
    if (addedTools.length > 0) {
      const addedCore = addedTools.filter(t => WebToolRegistry.getTier(t) === "core");
      const addedExt = addedTools.filter(t => WebToolRegistry.getTier(t) === "extended");
      deltaPayload.added = [
        ...addedCore.map(buildCompactCoreSpec),
        ...addedExt.map(buildCompactCoreSpec),
      ];
    }
    if (removedToolNames.length > 0) {
      deltaPayload.removed = removedToolNames;
    }
    if (correctionSpecs.length > 0) {
      deltaPayload.schema_fix = correctionSpecs;
    }

    const header = failedToolName
      ? `[MCP TOOL DELTA / SCHEMA CORRECTION: ${failedErrorCode || "ERROR"}]`
      : "[MCP TOOL DELTA]";
    const note = failedErrorMessage ? `${failedErrorMessage}\n` : "";

    return `${header}\n${note}\`\`\`json\n${JSON.stringify(deltaPayload, null, 2)}\n\`\`\``;
  }
}

export const mcpToolCatalogRenderer = new McpToolCatalogRenderer();
