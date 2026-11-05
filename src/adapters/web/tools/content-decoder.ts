export type M365ContentEncoding = "plain" | "base64";

export interface DecodeContentOptions {
  encoding?: M365ContentEncoding | string;
}

/** Decode đúng một lần theo encoding khai báo; không suy luận bằng extension hay escape heuristic. */
export function decodeM365Content(value: unknown, options: DecodeContentOptions = {}): string {
  const content = typeof value === "string" ? value : String(value ?? "");
  const encoding = options.encoding || "plain";
  if (encoding === "plain") return content;
  if (encoding === "base64") return Buffer.from(content, "base64").toString("utf8");
  throw new Error(`Unsupported M365 content encoding: ${encoding}`);
}

export interface NormalizeFileContentOptions {
  unescapeNewlines?: boolean;
  targetPath?: string;
  preserveExact?: boolean;
}

/**
 * @deprecated Compatibility facade. Runtime mới bảo toàn nội dung nguyên trạng và chỉ decode
 * bằng decodeM365Content khi protocol khai báo content_encoding rõ ràng.
 */
export function normalizeFileContent(
  content: string,
  optionsOrUnescape: boolean | string | NormalizeFileContentOptions = true
): string {
  const options: NormalizeFileContentOptions = typeof optionsOrUnescape === "boolean"
    ? { unescapeNewlines: optionsOrUnescape }
    : typeof optionsOrUnescape === "string"
      ? { targetPath: optionsOrUnescape }
      : optionsOrUnescape;
  if (typeof content !== "string") return String(content ?? "");

  const targetPath = (options.targetPath || "").toLowerCase();
  const isDocumentOrData = Boolean(options.preserveExact)
    || [".md", ".markdown", ".json", ".yaml", ".yml", ".toml", ".txt", ".csv"]
      .some(extension => targetPath.endsWith(extension));
  if (isDocumentOrData) {
    if (options.unescapeNewlines !== false && content.includes("\\n") && !content.includes("\n")) {
      return content.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
    }
    return content;
  }
  if (options.unescapeNewlines === false) return content;

  let result = content
    .replace(/\\([\[\]{}*_~])/g, "$1")
    .replace(/^[ \t]*\\+[ \t]*(\r?\n|$)/gm, "$1")
    .replace(/\\+[ \t]*(\r?\n)/g, "$1")
    .replace(/\\+[ \t]*\\n/g, "\\n");
  if (result.includes("\\n")) {
    result = result.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  }
  result = result
    .replace(/\\+[ \t]*(\r?\n)/g, "$1")
    .replace(/\\+[ \t]*$/g, "");

  if ([".html", ".htm", ".xml", ".svg"].some(extension => targetPath.endsWith(extension))) {
    result = result.replace(
      /^([ \t]*)(?:<script\s+src=["'\s]*)?([a-zA-Z0-9_./-]+\.js)(?:["'\s]*>)?(?:<\/)?[sS]cript>?/gm,
      "$1<script src=\"$2\"></script>"
    );
    result = result.replace(
      /^([ \t]*)(?:<script\s+src=["'\s]*)?([a-zA-Z0-9_./-]+\.js)(?:["'\s]*>)?(?:<\/)?[aA]tch$/gm,
      "$1<script src=\"$2\"></script>"
    );
    result = result.replace(
      /^([ \t]*)(?:<link\s+[^>\n]*href=["'\s]*)?([a-zA-Z0-9_./-]+\.css)(?:["'\s]*>)?(?:<\/)?[lL]ink>?/gm,
      "$1<link rel=\"stylesheet\" href=\"$2\">"
    );
  }
  return result;
}
