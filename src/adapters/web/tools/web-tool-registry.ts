import { namespacedToolName, type CodexTool } from "../../../types";
import type { NormalizedTool } from "../normalization/canonical-types";

export const INTERNAL_TOOL_DESCRIBE_NAME = "tools.describe";
export type WebToolTier = "core" | "extended";

export interface McpToolFullSpec {
  name: string;
  kind: "function" | "custom";
  namespace?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolDescribeLookupResult {
  found: McpToolFullSpec[];
  notFound: Array<{ requestedName: string; suggestions: string[] }>;
}

const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  readfile: "read_file",
  listdir: "list_dir",
  searchfiles: "search_files",
  grepcode: "grep_code",
  gitstatus: "git_status",
  gitdiff: "git_diff",
  execcommand: "exec_command",
  execute_command: "exec_command",
  executecommand: "exec_command",
  run_command: "exec_command",
  runcommand: "exec_command",
  run_cmd: "exec_command",
  runcmd: "exec_command",
  bash: "exec_command",
  shell: "exec_command",
  terminal: "exec_command",
  applypatch: "apply_patch",
  writefile: "write_file",
  requestuserinput: "request_user_input",
  tools_describe: INTERNAL_TOOL_DESCRIBE_NAME,
  describe_tools: INTERNAL_TOOL_DESCRIBE_NAME,
};

const BRIDGE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "search_files",
  "grep_code",
  "git_status",
  "git_diff",
  "run_command",
  "exec_command",
  "write_file",
  "apply_patch",
  "write_stdin",
  "view_image",
  "request_user_input",
  "create_goal",
  "update_goal",
  "get_goal",
  "tool_search",
]);

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "search_files",
  "grep_code",
  "git_status",
  "git_diff",
  "view_file",
  "view_image",
  "grep_search",
  "read_url_content",
  "get_goal",
  "tool_search",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

const CORE_TIER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "exec_command",
  "apply_patch",
  "exec",
  "write_stdin",
  "request_user_input",
  "read_file",
  "write_file",
  "list_dir",
  "search_files",
  "grep_code",
  "git_status",
  "git_diff",
  "view_image",
  "tool_search",
]);

const CANONICAL_CURATED_DESCRIPTIONS: Readonly<Record<string, string>> = {
  exec_command:
    "Chạy câu lệnh CLI không tương tác trong shell/cwd đã khai báo. Chỉ dùng khi không có semantic tool phù hợp.",
  write_stdin:
    "Gửi thêm dữ liệu hoặc đọc tiếp output của phiên exec_command đang chạy qua session_id.",
  list_mcp_resources:
    "Liệt kê resource do MCP server cung cấp.",
  list_mcp_resource_templates:
    "Liệt kê resource template do MCP server cung cấp.",
  read_mcp_resource:
    "Đọc một MCP resource bằng server và URI chính xác.",
  request_user_input:
    "Mở hộp thoại wizard hỏi người dùng chốt lựa chọn/thông tin quan trọng.",
  apply_patch:
    "Tạo hoặc sửa 1 file mỗi lượt bằng raw patch (freeform *** Begin Patch ... *** End Patch, không bọc JSON).",
  view_image:
    "Mở ảnh cục bộ để kiểm tra trực quan.",
  get_goal:
    "Đọc trạng thái goal hiện tại khi workflow goal được sử dụng.",
  create_goal:
    "Tạo goal mới khi được yêu cầu rõ ràng.",
  update_goal:
    "Cập nhật trạng thái goal hiện tại.",
  "web.run":
    "Truy cập web khi cần thông tin trực tuyến hoặc nguồn bên ngoài.",
  "image_gen.imagegen":
    "Tạo hoặc chỉnh sửa hình ảnh khi người dùng yêu cầu.",
  tool_search:
    "Tìm và nạp thêm các deferred tools (như multi_agent_v1 hoặc extra MCP) cho lượt tiếp theo.",
};

const MAX_COMPACT_DESCRIPTION_CHARS = 240;
const MAX_FULL_DESCRIPTION_CHARS = 1_200;

/**
 * Single Source of Truth cho toàn bộ metadata, phân tầng Tier, alias,
 * validation matching và MCP schema lookup của Web Adapter.
 */
export class WebToolRegistry {
  static readonly ALIASES = TOOL_NAME_ALIASES;
  static readonly BRIDGE_TOOLS = BRIDGE_TOOLS;
  static readonly READ_ONLY_TOOLS = READ_ONLY_TOOLS;
  static readonly CORE_TOOL_NAMES = CORE_TIER_TOOL_NAMES;

  static isInternalDescribeTool(name?: string): boolean {
    if (!name || typeof name !== "string") return false;
    return this.normalizeToolName(name) === INTERNAL_TOOL_DESCRIBE_NAME;
  }

  static normalizeToolName(name: string): string {
    const raw = name.trim();
    const withoutNamespace = raw.startsWith("functions.")
      ? raw.slice("functions.".length)
      : raw;
    const lower = withoutNamespace.toLowerCase();
    return (
      TOOL_NAME_ALIASES[lower] ||
      TOOL_NAME_ALIASES[withoutNamespace] ||
      withoutNamespace
    );
  }

  static isReadOnlyTool(name?: string): boolean {
    if (!name || typeof name !== "string") return false;
    const normalized = this.normalizeToolName(name).toLowerCase();
    return READ_ONLY_TOOLS.has(normalized) || READ_ONLY_TOOLS.has(name.trim().toLowerCase());
  }

  static getTier(tool: NormalizedTool): WebToolTier {
    const wireName = tool.identity.qualifiedName || tool.identity.name;
    if (!tool.identity.namespace && CORE_TIER_TOOL_NAMES.has(tool.identity.name)) {
      return "core";
    }
    if (CORE_TIER_TOOL_NAMES.has(wireName)) {
      return "core";
    }
    return "extended";
  }

  static cleanDescription(name: string, rawDesc?: string): string {
    if (!rawDesc) return "No description provided.";
    let desc = rawDesc.trim();
    desc = desc.replace(/¨C[a-zA-Z0-9_-]+C/g, "").replace(/\s{2,}/g, " ").trim();

    if (name.includes("exec_command") || name.includes("execcommand")) {
      const firstPart = desc.split(/Windows safety rules:/i)[0].trim();
      if (firstPart) desc = firstPart;
    }

    if (name.includes("web") || desc.includes("## Examples") || desc.includes("---")) {
      desc = desc.split("\n---")[0].split("\n##")[0].trim();
    }

    if (name.includes("goal") && desc.length > 200) {
      desc = desc.split("\n\n")[0] || desc.slice(0, 200);
    }

    if (name.includes("request_user_input") && desc.length > 250) {
      desc = desc.split("\n\n")[0] || desc.slice(0, 200);
    }

    return desc.trim();
  }

  static getCuratedDescription(tool: NormalizedTool, compact: boolean): string {
    const wireName = tool.identity.qualifiedName || tool.identity.name;
    const curated =
      CANONICAL_CURATED_DESCRIPTIONS[wireName] ||
      CANONICAL_CURATED_DESCRIPTIONS[tool.identity.name];
    if (curated) return curated;

    const raw = (tool.description || "Không có mô tả.")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const cleaned = this.cleanDescription(wireName, raw);
    const maxChars = compact
      ? MAX_COMPACT_DESCRIPTION_CHARS
      : MAX_FULL_DESCRIPTION_CHARS;
    return cleaned.length > maxChars
      ? `${cleaned.slice(0, maxChars).trimEnd()}…`
      : cleaned;
  }

  static findMatchingClientTool(
    requestedName: string,
    clientTools: CodexTool[] = [],
  ): CodexTool | undefined {
    const clean = requestedName.startsWith("functions.")
      ? requestedName.slice("functions.".length)
      : requestedName;

    const exact = clientTools.find(tool => {
      const dotted = tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name;
      const underscored = namespacedToolName(tool.namespace, tool.name);
      return (
        (!tool.namespace && tool.name === clean) ||
        dotted === clean ||
        underscored === clean ||
        tool.name === requestedName
      );
    });
    if (exact) return exact;

    const shortMatches = clientTools.filter(tool => tool.name === clean);
    return shortMatches.length === 1 ? shortMatches[0] : undefined;
  }

  static isClientToolAdvertised(
    requestedName: string,
    clientTools: CodexTool[] = [],
  ): boolean {
    if (clientTools.length === 0) {
      return BRIDGE_TOOLS.has(this.normalizeToolName(requestedName));
    }
    return this.findMatchingClientTool(requestedName, clientTools) !== undefined;
  }

  static toCodexWireToolName(tool: CodexTool): string {
    return namespacedToolName(tool.namespace, tool.name);
  }

  static buildFullMcpToolDefinition(tool: NormalizedTool): McpToolFullSpec {
    const wireName = tool.identity.qualifiedName || tool.identity.name;
    const description = this.getCuratedDescription(tool, false);

    if (tool.kind === "custom") {
      return {
        name: wireName,
        kind: "custom",
        ...(tool.identity.namespace ? { namespace: tool.identity.namespace } : {}),
        description,
        inputSchema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description:
                wireName === "apply_patch"
                  ? "Raw patch bắt đầu bằng *** Begin Patch và kết thúc bằng *** End Patch (đặt trực tiếp trong <custom_tool_call name=\"apply_patch\">)."
                  : "Raw freeform text input.",
            },
          },
          required: ["input"],
        },
      };
    }

    return {
      name: wireName,
      kind: "function",
      ...(tool.identity.namespace ? { namespace: tool.identity.namespace } : {}),
      description,
      inputSchema:
        tool.rawParameters && Object.keys(tool.rawParameters).length > 0
          ? tool.rawParameters
          : { type: "object", properties: {} },
    };
  }

  static describeTools(
    requestedNames: string[],
    activeTools: NormalizedTool[],
  ): ToolDescribeLookupResult {
    const found: McpToolFullSpec[] = [];
    const notFound: Array<{ requestedName: string; suggestions: string[] }> = [];
    const seen = new Set<string>();

    for (const rawName of requestedNames) {
      const trimmed = String(rawName || "").trim();
      if (!trimmed) continue;

      const clean = trimmed.startsWith("functions.")
        ? trimmed.slice("functions.".length)
        : trimmed;
      const lower = clean.toLowerCase();

      const matched = activeTools.find(tool => {
        const dotted = tool.identity.qualifiedName;
        const underscored = tool.identity.namespace
          ? `${tool.identity.namespace}__${tool.identity.name}`
          : tool.identity.name;
        return (
          dotted === clean ||
          underscored === clean ||
          dotted.toLowerCase() === lower ||
          underscored.toLowerCase() === lower ||
          tool.identity.name === clean
        );
      });

      if (matched) {
        const key = matched.identity.qualifiedName;
        if (!seen.has(key)) {
          seen.add(key);
          found.push(this.buildFullMcpToolDefinition(matched));
        }
        continue;
      }

      const suggestions = activeTools
        .map(t => t.identity.qualifiedName)
        .filter(qName => qName.toLowerCase().includes(lower) || lower.includes(qName.toLowerCase()))
        .slice(0, 5);
      notFound.push({ requestedName: trimmed, suggestions });
    }

    return { found, notFound };
  }
}
