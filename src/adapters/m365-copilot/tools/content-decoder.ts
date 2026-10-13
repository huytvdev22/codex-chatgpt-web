import {
  ToolContentDecoder,
  type ContentEncoding,
  type DecodeContentOptions,
  type NormalizeFileContentOptions,
} from "../../base-web/tools";

export type M365ContentEncoding = ContentEncoding;
export type { DecodeContentOptions, NormalizeFileContentOptions };

export function decodeM365Content(value: unknown, options: DecodeContentOptions = {}): string {
  return ToolContentDecoder.decodeContent(value, options);
}

export function normalizeFileContent(
  content: string,
  optionsOrUnescape: boolean | string | NormalizeFileContentOptions = true
): string {
  return ToolContentDecoder.normalizeFileContent(content, optionsOrUnescape);
}
