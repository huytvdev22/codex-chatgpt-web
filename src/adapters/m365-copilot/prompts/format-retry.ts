export interface M365FormatRetryOptions {
  code: string;
  message: string;
}

/** Tạo follow-up yêu cầu M365 phát lại cùng nội dung, tuyệt đối không tiếp tục tác vụ. */
export function buildM365FormatRetryPrompt(options: M365FormatRetryOptions): string {
  const isTransportOnly = options.code === "MISSING_TRANSPORT_FENCE";

  const formatInstruction = isTransportOnly
    ? `\`\`\`\`markdown
... toàn bộ final answer Markdown ...
\`\`\`\``
    : `\`\`\`\`markdown
<m365Response>
... toàn bộ action tool call hoàn chỉnh HOẶC final answer ...
</m365Response>
\`\`\`\``;

  const constraintRules = isTransportOnly
    ? `- BẮT BUỘC bọc toàn bộ nội dung trong đúng một khối code 4 dấu backtick: \`\`\`\`markdown ... \`\`\`\`.
- Viết Markdown tự nhiên trực tiếp, KHÔNG bọc thẻ <m365Response> và KHÔNG chứa cú pháp gọi tool.
- Tuyệt đối không viết bất kỳ ký tự nào bên ngoài khối 4-backtick.
- Không xuất <thought>/<thinking>.`
    : `- Chỉ đúng một cặp <m365Response>...</m365Response>.
- Nếu gọi tool: bên trong chỉ được có các <tool_call> JSON hoàn chỉnh hoặc <custom_tool_call name="apply_patch"> hoàn chỉnh; không chèn lời dẫn.
- Nếu trả final answer: không được chứa tool syntax.
- Không xuất <thought>/<thinking>.
- Không tự đóng hoặc rút gọn JSON, tool tag hay patch.`;

  return `[M365 RESPONSE FORMAT ERROR - BẮT BUỘC PHÁT LẠI PHẢN HỒI TRƯỚC]
Phản hồi ngay trước của bạn đã bị IDE hủy toàn bộ và KHÔNG có công cụ nào được thực thi.
Mã lỗi: ${options.code}
Chi tiết: ${options.message}

Không tiếp tục sang bước mới. Hãy phát lại đúng nội dung dự định của phản hồi trước theo DUY NHẤT format sau:

${formatInstruction}

Ràng buộc bắt buộc:
${constraintRules}`;
}
