import type { FormatRetryOptions } from "../dto/format-retry-options.dto";

export class FormatRetryBuilder {
  /**
   * Rút gọn diagnostic để không chuyển tiếp các ví dụ code fence và control
   * frame từ strict parser sang model trong lượt Format Retry.
   */
  private static summarizeDiagnostic(message: string): string {
    const normalized = String(message || "")
      .replace(/`{3,4}[\s\S]*?`{3,4}/g, " ")
      .replace(/&lt;[^&gt;\n]+&gt;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) {
      return "Phản hồi trước không đúng giao thức đầu ra bắt buộc.";
    }

    return normalized.length > 240
      ? `${normalized.slice(0, 240).trimEnd()}…`
      : normalized;
  }

  /**
   * Tạo follow-up yêu cầu mô hình phát lại cùng nội dung, tuyệt đối không tiếp tục tác vụ.
   */
  static buildFormatRetryPrompt(optionsOrCode: FormatRetryOptions | string, maybeMessage?: string): string {
    const options: FormatRetryOptions = typeof optionsOrCode === "string"
      ? { code: optionsOrCode, message: maybeMessage || "" }
      : optionsOrCode;
    const diagnostic = this.summarizeDiagnostic(options.message);

    return `[M365 RESPONSE FORMAT ERROR - BẮT BUỘC PHÁT LẠI PHẢN HỒI TRƯỚC]
Phản hồi ngay trước của bạn đã bị IDE hủy toàn bộ và KHÔNG có công cụ nào được thực thi.
Mã lỗi: ${options.code}
Chi tiết ngắn: ${diagnostic}

Không tiếp tục sang bước mới. Hãy phát lại đúng nội dung dự định của phản hồi trước theo DUY NHẤT format sau:

\`\`\`\`markdown
<webResponse>
... toàn bộ final answer Markdown HOẶC một hay nhiều tool call hoàn chỉnh ...
</webResponse>
\`\`\`\`

Ràng buộc bắt buộc:
- Chỉ đúng một cặp <webResponse>...</webResponse>.
- Nếu gọi tool: bên trong chỉ được có các <tool_call> JSON hoàn chỉnh hoặc <custom_tool_call name="apply_patch"> hoàn chỉnh; không chèn lời dẫn.
- Nếu trả final answer: không được chứa tool syntax.
- Không xuất <thought>/<thinking>.
- Không tự đóng hoặc rút gọn JSON, tool tag hay patch.`;
  }
}
