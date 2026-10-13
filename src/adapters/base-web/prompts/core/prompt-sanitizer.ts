import type { CodexContentPart } from "../../../../types";

export const MAX_TOOL_RESULT_CHARS = 8_000;
export const MAX_WEB_PROMPT_CHARS = 95_000;

export class PromptSanitizer {
  /**
   * Cắt tỉa nội dung kết quả công cụ (Truncation Guard) để bảo vệ giao diện Web
   * khỏi nguy cơ quá tải bộ đệm khi log hoặc file quá lớn.
   */
  static truncateToolResult(content: string, maxChars = MAX_TOOL_RESULT_CHARS): string {
    if (content.length <= maxChars) return content;
    const half = Math.floor((maxChars - 200) / 2);
    const head = content.slice(0, half);
    const tail = content.slice(-half);
    const omitted = content.length - (head.length + tail.length);
    return `${head}\n\n[... Đã lược bớt ${omitted} ký tự ở giữa để tối ưu kích thước phản hồi ...]\n\n${tail}`;
  }

  /**
   * Loại bỏ instruction nội bộ của Codex khỏi prompt gửi sang Web chat.
   * Chỉ giữ project/developer rules có ý nghĩa đối với quá trình thực thi.
   */
  static sanitizeCodexInstructions(text: string): string {
    return text
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
      .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, "")
      .replace(/<apps_instructions>[\s\S]*?<\/apps_instructions>/gi, "")
      .replace(/<plugins_instructions>[\s\S]*?<\/plugins_instructions>/gi, "")
      .replace(/<tools>[\s\S]*?<\/tools>/gi, "")
      .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, "")
      .replace(/<permissions[\s\S]*?<\/permissions[^>]*>/gi, "")
      .replace(/<sandbox[\s\S]*?<\/sandbox[^>]*>/gi, "")
      .replace(
        /<\/?(?:collaboration_mode|apps_instructions|plugins_instructions|tools|skills_instructions)>/gi,
        ""
      )
      .replace(/# Apps \(Connectors\)[\s\S]*?(?=\n# |\n\[|$)/gi, "")
      .replace(/# Plugins[\s\S]*?(?=\n# |\n\[|$)/gi, "")
      .replace(/Deferred tool namespaces:[\s\S]*?(?=\n# |\n\[|$)/gi, "")
      .replace(/You are Codex[\s\S]*?(?=\n# |\n\[|\n\n|$)/gi, "")
      .replace(/¨C[a-zA-Z0-9_-]+C/g, "")
      .trim();
  }

  /**
   * Chuyển đổi nội dung tin nhắn dạng chuỗi hoặc content blocks thành văn bản thuần.
   */
  static stringifyContent(content: string | CodexContentPart[]): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map(part => {
          if (part.type === "text") return part.text;
          if (part.type === "image") return `[Image: ${part.imageUrl.slice(0, 50)}...]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }
}
