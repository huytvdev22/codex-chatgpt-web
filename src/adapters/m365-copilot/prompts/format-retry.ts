export interface M365FormatRetryOptions {
  code: string;
  message: string;
}

/** Tạo follow-up yêu cầu M365 phát lại cùng nội dung, tuyệt đối không tiếp tục tác vụ. */
export function buildM365FormatRetryPrompt(options: M365FormatRetryOptions): string {
  return `Bạn ơi, tin nhắn vừa rồi bạn gửi hơi lệch quy ước định dạng một chút nên script cầu nối trên máy mình chưa bóc tách để chạy lệnh được (chưa có công cụ nào được chạy ở lượt vừa rồi cả).
- Điểm bị vấp: [${options.code}] ${options.message}

Bạn giúp mình gửi lại đúng nội dung bạn vừa định làm ở lượt trước vào chuẩn khung này để script mình đọc lại nhé:

\`\`\`\`markdown
<m365Response>
... chỉ đặt các khối <tool_call> / <custom_tool_call name="apply_patch"> hoàn chỉnh (không kèm lời dẫn, không kèm <thought>), HOẶC nội dung câu trả lời Markdown cuối cùng ...
</m365Response>
\`\`\`\``;
}
