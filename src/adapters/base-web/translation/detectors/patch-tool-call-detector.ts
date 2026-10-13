import type { IToolCallDetector } from "../contracts/tool-call-detector.interface";
import type { DetectedToolCall } from "../dto/detected-tool-call.dto";
import { sanitizeCodexPatchContent } from "./sanitizers";

export { sanitizeCodexPatchContent };

/**
 * Bộ phát hiện Codex Patch Tool Call (Ưu tiên 0)
 * Phát hiện các khối patch:
 * *** Begin Patch
 * ...
 * *** End Patch
 */
export class PatchToolCallDetector implements IToolCallDetector {
  readonly priority = 0;
  readonly name = "PatchToolCallDetector";

  /**
   * Phát hiện và phân tích tool call dạng áp bản vá (apply_patch / diff).
   */
  detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null {
    if (!rawResponse || !rawResponse.trim()) return null;

    // Chuẩn hóa ký tự * bị escape bởi Turndown trước khi tìm kiếm
    const unescaped = rawResponse.replaceAll("\\*", "*");

    // 1. Kiểm tra thẻ <custom_tool_call name="apply_patch">...</custom_tool_call> trước
    const customMatch = unescaped.match(/<\s*custom[\\_]*tool[\\_]*call(?:\s+name=["']apply_patch["'])?\s*>([\s\S]*?)<\s*\/custom[\\_]*tool[\\_]*call\s*>/i);
    if (customMatch) {
      const cleanedPatch = sanitizeCodexPatchContent(customMatch[1]);
      if (cleanedPatch.includes("*** Begin Patch")) {
        return {
          name: "apply_patch",
          arguments: { input: cleanedPatch },
        };
      }
    }

    // 2. Tìm tất cả các khối hoàn chỉnh: *** Begin Patch ... *** End Patch (hỗ trợ cả 2 hoặc 3 dấu sao)
    const matches = [...unescaped.matchAll(/\*{2,3}\s*Begin Patch([\s\S]*?)\*{2,3}\s*End Patch/gi)];
    if (matches.length > 0) {
      const calls: DetectedToolCall[] = [];
      for (const m of matches) {
        const cleanedPatch = sanitizeCodexPatchContent(m[0]);
        calls.push({
          name: "apply_patch",
          arguments: { input: cleanedPatch },
        });
      }
      return calls.length === 1 ? calls[0] : calls;
    }

    // 3. Nếu khối patch có Begin Patch và chứa header File (Update/Add/Delete),
    // cho phép auto-close *** End Patch khi stream đã kết thúc
    const openMatch = unescaped.match(/\*{2,3}\s*Begin Patch([\s\S]*)$/i);
    if (openMatch && /\*{2,3}\s*(?:Update|Add|Delete)\s*File:/i.test(openMatch[1])) {
      let rawSnippet = openMatch[0];
      const junkIdx = rawSnippet.search(/["']\}\s*<\s*\/tool|Provide your feedback|BizChat/i);
      if (junkIdx >= 0) {
        rawSnippet = rawSnippet.slice(0, junkIdx);
      }
      let cleanedPatch = sanitizeCodexPatchContent(rawSnippet);
      if (!cleanedPatch.endsWith("*** End Patch")) {
        cleanedPatch = `${cleanedPatch}\n*** End Patch`;
      }
      return {
        name: "apply_patch",
        arguments: { input: cleanedPatch },
      };
    }

    return null;
  }
}
