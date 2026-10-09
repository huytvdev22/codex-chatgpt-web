import { logFunctionInput } from "../debug-logger";
import { AtomicFileWriter } from "../tools/atomic-file-writer";
import type { OpenAIToolCall } from "./detectors/types";

/**
 * Mask arguments string cho log console để giấu secret / dữ liệu lớn
 */
export function maskArgumentsForLog(argsStr: string): string {

  try {
    const parsed = JSON.parse(argsStr);
    if (parsed && typeof parsed === "object") {
      const masked = { ...parsed };
      if (typeof masked.content === "string") {
        const sha = AtomicFileWriter.computeSha256(masked.content);
        const byteLen = Buffer.byteLength(masked.content, "utf8");
        masked.content = `[PROTECTED: ${byteLen} bytes, sha256: ${sha}]`;
      }
      if (typeof masked.patch === "string" && masked.patch.length > 200) {
        masked.patch = `[PROTECTED: ${Buffer.byteLength(masked.patch, "utf8")} bytes]`;
      }
      if (typeof masked.input === "string" && masked.input.length > 200) {
        masked.input = `[PROTECTED: ${Buffer.byteLength(masked.input, "utf8")} bytes]`;
      }
      return JSON.stringify(masked);
    }
  } catch { }
  if (argsStr.length > 300) {
    return `${argsStr.slice(0, 150)}... [TRUNCATED ${argsStr.length - 250} chars] ...${argsStr.slice(-100)}`;
  }
  return argsStr;
}

/**
 * Che giấu secret và dữ liệu lớn khi in log ra console (Yêu cầu 10)
 */
export function maskToolCallsForLog(toolCalls: OpenAIToolCall[]): any[] {

  return toolCalls.map(tc => {
    try {
      const parsedArgs = JSON.parse(tc.function.arguments);
      if (parsedArgs && typeof parsedArgs === "object") {
        const masked = { ...parsedArgs };
        if (typeof masked.content === "string") {
          const sha = AtomicFileWriter.computeSha256(masked.content);
          const byteLen = Buffer.byteLength(masked.content, "utf8");
          masked.content = `[PROTECTED: ${byteLen} bytes, sha256: ${sha}]`;
        }
        if (typeof masked.patch === "string" && masked.patch.length > 200) {
          masked.patch = `[PROTECTED: ${Buffer.byteLength(masked.patch, "utf8")} bytes]`;
        }
        if (typeof masked.input === "string" && masked.input.length > 200) {
          masked.input = `[PROTECTED: ${Buffer.byteLength(masked.input, "utf8")} bytes]`;
        }
        return {
          ...tc,
          function: {
            ...tc.function,
            arguments: masked,
          },
        };
      }
    } catch { }
    return tc;
  });
}
