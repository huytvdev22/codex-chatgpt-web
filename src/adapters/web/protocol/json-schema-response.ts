import type { CodexJsonSchemaOutputFormat } from "../../../types";
import type { StrictWebResponseResult } from "./strict-response-parser";
import { stripOuterCodeFence } from "./strip-code-fence";

function unwrapCandidateText(rawResponse: string): string {
  let current = rawResponse.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

  // Bóc tối đa 2 lớp fence ngoài cùng (vd: ````markdown bao quanh ```json ... ```)
  for (let pass = 0; pass < 2; pass += 1) {
    const unwrapped = stripOuterCodeFence(current);
    if (unwrapped === current) break;
    current = unwrapped;
  }

  // Nếu trợ lý lỡ bọc thêm <webResponse>...</webResponse>, gỡ vỏ để lấy nội dung JSON bên trong.
  const webResponseMatch = current.match(
    /^<webResponse>\s*([\s\S]*?)\s*<\/webResponse>$/i,
  );
  if (webResponseMatch) {
    current = stripOuterCodeFence(webResponseMatch[1].trim());
  }

  return current.trim();
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function extractBalancedJsonSlice(text: string): string | null {
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === open) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const slice = text.slice(start, i + 1);
          if (tryParseJson(slice).ok) {
            return slice;
          }
          break;
        }
      }
    }
  }
  return null;
}

function parseJsonValue(rawResponse: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const cleaned = unwrapCandidateText(rawResponse);
  if (!cleaned) {
    return { ok: false, reason: "Phản hồi rỗng, không có dữ liệu JSON." };
  }

  const direct = tryParseJson(cleaned);
  if (direct.ok) return direct;

  // Thử tìm fenced code block ```json ... ``` hoặc ``` ... ``` nằm lẫn trong văn bản
  const fencedRegex = /`{3,5}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n`{3,5}/gi;
  let match: RegExpExecArray | null;
  while ((match = fencedRegex.exec(cleaned)) !== null) {
    const inner = match[1].trim();
    const parsedBlock = tryParseJson(inner);
    if (parsedBlock.ok) {
      return parsedBlock;
    }
  }

  // Fallback cuối: dò lát cắt JSON object/array cân bằng đầu tiên hợp lệ
  const balanced = extractBalancedJsonSlice(cleaned);
  if (balanced) {
    const parsedSlice = tryParseJson(balanced);
    if (parsedSlice.ok) return parsedSlice;
  }

  return {
    ok: false,
    reason: "Không tìm thấy đối tượng/mảng JSON hợp lệ trong phản hồi (tránh xuất YAML hoặc văn bản thuần).",
  };
}

function matchesJsonType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Kiểm tra giá trị JSON có hợp lệ với JSON Schema phổ biến của OpenAI/Codex Structured Output hay không.
 * Trả về `null` nếu hợp lệ, hoặc chuỗi mô tả lỗi đầu tiên.
 */
export function validateValueAgainstJsonSchema(
  value: unknown,
  schema: unknown,
  path = "$",
): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    const anyMatch = s.anyOf.some(branch => validateValueAgainstJsonSchema(value, branch, path) === null);
    if (!anyMatch) {
      return `${path} không khớp bất kỳ nhánh anyOf nào của schema.`;
    }
  }

  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    const matches = s.oneOf.filter(branch => validateValueAgainstJsonSchema(value, branch, path) === null);
    if (matches.length !== 1) {
      return `${path} phải khớp đúng 1 nhánh oneOf của schema.`;
    }
  }

  if (Array.isArray(s.allOf) && s.allOf.length > 0) {
    for (const branch of s.allOf) {
      const err = validateValueAgainstJsonSchema(value, branch, path);
      if (err) return err;
    }
  }

  if ("const" in s && JSON.stringify(value) !== JSON.stringify(s.const)) {
    return `${path} phải bằng hằng số ${JSON.stringify(s.const)}.`;
  }

  if (Array.isArray(s.enum)) {
    const serialized = JSON.stringify(value);
    const matched = s.enum.some(item => JSON.stringify(item) === serialized);
    if (!matched) {
      return `${path} không thuộc danh sách enum hợp lệ.`;
    }
  }

  if (typeof s.type === "string") {
    if (!matchesJsonType(value, s.type)) {
      return `${path} phải có kiểu "${s.type}".`;
    }
  } else if (Array.isArray(s.type) && s.type.length > 0) {
    const allowedTypes = s.type.map(String);
    if (!allowedTypes.some(t => matchesJsonType(value, t))) {
      return `${path} phải có kiểu thuộc [${allowedTypes.join(", ")}].`;
    }
  }

  if (Array.isArray(value) && s.items !== undefined) {
    for (let i = 0; i < value.length; i += 1) {
      const itemErr = validateValueAgainstJsonSchema(value[i], s.items, `${path}[${i}]`);
      if (itemErr) return itemErr;
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(s.required) ? s.required.map(String) : [];
    for (const reqKey of required) {
      if (!(reqKey in record) || record[reqKey] === undefined) {
        return `${path} thiếu trường bắt buộc "${reqKey}".`;
      }
    }

    const properties =
      s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)
        ? (s.properties as Record<string, unknown>)
        : undefined;

    for (const [key, propVal] of Object.entries(record)) {
      if (properties && key in properties) {
        const propErr = validateValueAgainstJsonSchema(propVal, properties[key], `${path}.${key}`);
        if (propErr) return propErr;
      } else if (s.additionalProperties === false) {
        return `${path} chứa trường không được phép "${key}".`;
      } else if (
        s.additionalProperties &&
        typeof s.additionalProperties === "object" &&
        !Array.isArray(s.additionalProperties)
      ) {
        const addErr = validateValueAgainstJsonSchema(propVal, s.additionalProperties, `${path}.${key}`);
        if (addErr) return addErr;
      }
    }
  }

  return null;
}

/**
 * Parse và kiểm tra phản hồi cho các lượt Structured Output (`outputFormat.type === "json_schema"`).
 * Khi hợp lệ, chuẩn hóa nội dung trả về thành chuỗi JSON thuần gọn gàng để client Codex parse trực tiếp.
 */
export function parseAndValidateJsonSchemaResponse(
  rawResponse: string,
  outputFormat: CodexJsonSchemaOutputFormat,
): StrictWebResponseResult {
  const parsed = parseJsonValue(rawResponse);
  if (!parsed.ok) {
    return {
      kind: "protocol_error",
      code: "INVALID_JSON_SCHEMA_OUTPUT",
      message: `Phản hồi không phải JSON hợp lệ cho schema "${outputFormat.name}": ${parsed.reason}`,
      rawResponse,
    };
  }

  const schemaError = validateValueAgainstJsonSchema(parsed.value, outputFormat.schema);
  if (schemaError) {
    return {
      kind: "protocol_error",
      code: "INVALID_JSON_SCHEMA_OUTPUT",
      message: `JSON không khớp schema "${outputFormat.name}": ${schemaError}`,
      rawResponse,
    };
  }

  return {
    kind: "final_answer",
    content: JSON.stringify(parsed.value),
    rawResponse,
  };
}

