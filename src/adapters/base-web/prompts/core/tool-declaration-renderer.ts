import type { NormalizedTool } from "../../normalization";
import { ToolDescriptionCurator } from "./tool-description-curator";

export class ToolDeclarationRenderer {
  /**
   * Sinh ví dụ transport tối thiểu dựa trên đúng inventory của turn hiện tại.
   */
  static renderDynamicToolExamples(tools: NormalizedTool[], compact = false): string {
    const functionTool = tools.find(tool => tool.kind === "function");
    const applyPatchTool = tools.find(
      tool => tool.kind === "custom" && tool.identity.name === "apply_patch"
    );
    const examples: string[] = [];

    if (!compact && functionTool?.kind === "function") {
      const wireName = functionTool.identity.qualifiedName || functionTool.identity.name;
      const required = Array.isArray(functionTool.rawParameters.required)
        ? functionTool.rawParameters.required.map(String)
        : [];
      const properties =
        functionTool.rawParameters.properties &&
        typeof functionTool.rawParameters.properties === "object" &&
        !Array.isArray(functionTool.rawParameters.properties)
          ? functionTool.rawParameters.properties as Record<string, unknown>
          : {};
      const argumentsExample = Object.fromEntries(
        required.map((name: string) => {
          const schema = properties[name];
          const type =
            schema &&
            typeof schema === "object" &&
            !Array.isArray(schema) &&
            typeof (schema as Record<string, unknown>).type === "string"
              ? (schema as Record<string, unknown>).type
              : "string";
          const value =
            type === "number" || type === "integer"
              ? 1
              : type === "boolean"
                ? true
                : type === "array"
                  ? []
                  : type === "object"
                    ? {}
                    : `<${name}>`;
          return [name, value];
        })
      );

      examples.push(`FUNCTION ACTION EXAMPLE
\`\`\`\`markdown
<webResponse>
<tool_call>
${JSON.stringify({ name: wireName, arguments: argumentsExample })}
</tool_call>
</webResponse>
\`\`\`\``);
    }

    if (applyPatchTool) {
      const wireName = applyPatchTool.identity.qualifiedName || applyPatchTool.identity.name;
      examples.push(`FREEFORM ACTION EXAMPLE
\`\`\`\`markdown
<webResponse>
<custom_tool_call name="${wireName}">
*** Begin Patch
*** Update File: path/to/file.ext
@@
-old content
+new content
*** End Patch
</custom_tool_call>
</webResponse>
\`\`\`\`

File chưa tồn tại dùng *** Add File. File đã tồn tại dùng *** Update File.
Không dùng *** Add File để giả định ghi đè file đã tồn tại.`);
    }

    return examples.length > 0 ? `IDE BRIDGE TRANSPORT EXAMPLES\n\n${examples.join("\n\n")}` : "";
  }

  /**
   * Render Tool Declaration chuẩn mực cho Web Chat.
   * Sinh inventory trực tiếp từ native tools do Codex cung cấp.
   */
  static renderDynamicToolDeclarations(tools: NormalizedTool[] = []): string {
    if (tools.length === 0) {
      return "CODEX ACTION CONTRACT FOR THIS IDE TURN\n\nKhông có action nào được Codex quảng bá cho turn hiện tại.";
    }

    const formatSchemaType = (schema: unknown): string => {
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return "unknown";
      }

      const record = schema as Record<string, unknown>;
      if (typeof record.type === "string") {
        return record.type;
      }
      if (Array.isArray(record.type)) {
        return record.type.map(String).join(" | ");
      }
      if (Array.isArray(record.enum) && record.enum.length > 0) {
        return "enum";
      }
      return "unknown";
    };

    const formatSchemaDescription = (schema: unknown): string => {
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return "";
      }

      const record = schema as Record<string, unknown>;
      const description =
        typeof record.description === "string" ? record.description.replace(/\s+/g, " ").trim() : "";
      const enumValues = Array.isArray(record.enum)
        ? record.enum.map(value => JSON.stringify(value)).join(" | ")
        : "";

      return [description, enumValues ? `Giá trị hợp lệ: ${enumValues}.` : ""].filter(Boolean).join(" ");
    };

    const inventory = tools.map((tool, index) => {
      const wireName = tool.identity.qualifiedName || tool.identity.name;
      const header = `${index + 1}. ${wireName} (${tool.kind === "custom" ? "freeform" : "function"})`;
      const lines = [header, `   Mô tả: ${ToolDescriptionCurator.curateToolDescription(tool, false)}`];

      if (tool.identity.namespace) {
        lines.push(`   Namespace: ${tool.identity.namespace}`);
      }

      if (tool.kind === "custom") {
        lines.push("   Input: raw text hoàn chỉnh; không bọc trong arguments JSON.");
        if (tool.format !== undefined) {
          lines.push("   Ràng buộc: input phải tuân theo grammar/format được IDE cung cấp.");
        }
        return lines.join("\n");
      }

      const required = new Set(
        Array.isArray(tool.rawParameters.required) ? tool.rawParameters.required.map(String) : []
      );
      const properties =
        tool.rawParameters.properties &&
        typeof tool.rawParameters.properties === "object" &&
        !Array.isArray(tool.rawParameters.properties)
          ? tool.rawParameters.properties as Record<string, unknown>
          : {};
      const entries = Object.entries(properties);

      if (entries.length === 0) {
        lines.push("   Tham số: không có.");
        return lines.join("\n");
      }

      lines.push("   Tham số:");
      for (const [name, schema] of entries) {
        const requiredLabel = required.has(name) ? "bắt buộc" : "tùy chọn";
        const description = formatSchemaDescription(schema);
        lines.push(
          `   - ${name}: ${formatSchemaType(schema)}, ${requiredLabel}${
            description ? ` — ${description}` : ""
          }`
        );
      }

      return lines.join("\n");
    }).join("\n\n");

    const examples = ToolDeclarationRenderer.renderDynamicToolExamples(tools);

    return `CODEX ACTION CONTRACT FOR THIS IDE TURN

Các action sau do IDE bridge cung cấp cho turn hiện tại. Đây KHÔNG phải tool registry nội bộ của web chat.
- Chỉ yêu cầu action có trong contract này.
- Bắt buộc dùng đúng wire_name; không tự tạo alias.
- kind=function: dùng tool_call và JSON arguments đúng parameters schema.
- kind=freeform: dùng custom_tool_call và raw input; không chuyển raw input thành arguments JSON.
- Nếu semantic action phù hợp tồn tại, không thay thế bằng exec_command.
- Không thay IDE action bằng web.run, container.exec, python hoặc system tool nội bộ.
- Adapter chỉ validate và forward; Codex runtime chịu trách nhiệm thực thi, sandbox, approval và UI lifecycle.

${inventory}

${examples}`;
  }

  /**
   * Render Tool Declaration phiên bản COMPACT cho Web Chat từ Turn 2 trở đi.
   */
  static renderCompactDynamicToolDeclarations(tools: NormalizedTool[] = []): string {
    if (tools.length === 0) {
      return "CODEX ACTION CONTRACT (COMPACT): Không có action nào được Codex quảng bá.";
    }

    const inventory = tools.map(tool => {
      const wireName = tool.identity.qualifiedName || tool.identity.name;
      if (tool.kind === "custom") {
        return `- ${wireName} [freeform] — ${ToolDescriptionCurator.curateToolDescription(tool, true)}`;
      }

      const required = Array.isArray(tool.rawParameters.required)
        ? tool.rawParameters.required.map(String)
        : [];
      const properties =
        tool.rawParameters.properties &&
        typeof tool.rawParameters.properties === "object" &&
        !Array.isArray(tool.rawParameters.properties)
          ? Object.keys(tool.rawParameters.properties as Record<string, unknown>)
          : [];
      const fields = properties.map(name => (required.includes(name) ? `${name}*` : name));

      return `- ${wireName} [function]${fields.length > 0 ? `: ${fields.join(", ")}` : ""} — ${ToolDescriptionCurator.curateToolDescription(tool, true)}`;
    }).join("\n");

    const examples = ToolDeclarationRenderer.renderDynamicToolExamples(tools, true);

    return `CODEX ACTION CONTRACT FOR THIS IDE TURN (COMPACT)

Đây là IDE bridge contract, không phải tool registry nội bộ của web chat.
Chỉ dùng đúng wire_name dưới đây. Dấu * là trường bắt buộc.
Function action dùng JSON arguments; freeform action dùng raw input.
Không thay semantic action bằng exec_command hoặc system tool nội bộ.

${inventory}

${examples}`;
  }
}
