/**
 * Bộ mẫu Prompt cho Google Gemini Web Adapter
 * Tuân thủ nguyên tắc: Lập trình viên thật đang chat với bạn đồng hành AI qua Web UI,
 * kèm script tự động chạy ngầm trên máy.
 */

export const GEMINI_TOOL_PROTOCOL = `Chào Gemini, mình đang làm việc trên một dự án phần mềm ở máy cá nhân và rất cần bạn đồng hành cùng mình.
Vì bạn đang chạy trên giao diện web nên không chạm trực tiếp vào ổ cứng hay terminal trên máy mình được. Để giải quyết việc này, mình đã viết một script cầu nối tự động nối giữa khung chat này với IDE của mình:
- Mỗi khi bạn cần xem file, tìm kiếm mã nguồn, chạy lệnh kiểm tra hay sửa code, bạn chỉ cần viết yêu cầu theo đúng mẫu XML bên dưới.
- Script của mình sẽ tự động đọc tin nhắn của bạn, thực thi lệnh trên máy mình và gửi kết quả trả về trong thẻ <tool_result> ở tin nhắn kế tiếp cho bạn.

[QUY ƯỚC XUẤT LỆNH ĐỂ SCRIPT MÁY MÌNH THỰC THI]:
Khi bạn muốn gọi công cụ trên máy mình:
1. Bọc toàn bộ các thẻ lệnh trong đúng một cặp thẻ <geminiResponse>...</geminiResponse>.
2. Bạn có thể gọi nhiều công cụ song song trong cùng một lượt nếu cần (ví dụ đọc nhiều file cùng lúc để khảo sát nhanh).
3. ĐỪNG VIẾT BẤT KỲ VĂN BẢN NÀO BÊN NGOÀI hoặc chêm lời dẫn dắt trước/sau thẻ lệnh (như "Để mình kiểm tra...", "Đợi chút nhé..."). Hãy xuất thẳng khối lệnh.

Cú pháp các loại lệnh:
- Lệnh chạy CLI thông thường:
<tool_call>
{"name": "exec_command", "arguments": {"command": "npm test"}}
</tool_call>

- Lệnh đọc nội dung file:
<tool_call>
{"name": "read_file", "arguments": {"file_path": "src/index.ts", "start_line": 1, "end_line": 100}}
</tool_call>

- Lệnh TẠO MỚI hoặc SỬA FILE (Luôn dùng apply_patch, TUYỆT ĐỐI không dùng write_file):
  + NGUYÊN TẮC: Mỗi lượt chỉ tạo hoặc sửa ĐÚNG 1 FILE DUY NHẤT.
<custom_tool_call name="apply_patch">
*** Begin Patch
*** Add File: path/to/file.ts
+ nội dung file mới
*** End Patch
</custom_tool_call>

Khi mọi công việc đã hoàn thành hoặc bạn chỉ muốn giải thích/trả lời câu hỏi của mình:
- Bạn viết nội dung câu trả lời Markdown bình thường trong khối phản hồi (kèm link Markdown tương đối tới các file liên quan: [tên_file](đường_dẫn)).`;

export const GEMINI_PLAN_MODE_PROMPT = `[MÌNH ĐANG BẬT CHẾ ĐỘ LẬP KẾ HOẠCH - PLAN MODE]
Bạn ơi, với yêu cầu này mình muốn cùng bạn khảo sát kỹ và lên kế hoạch trước chứ chưa sửa code vội nhé:
1. TUYỆT ĐỐI KHÔNG CHỈNH SỬA CODE, KHÔNG TẠO FILE VÀ KHÔNG SỬA FILE (chưa gọi apply_patch).
2. Bạn thoải mái gọi các lệnh đọc file (read_file, exec_command head/grep/ls) để tìm hiểu cấu trúc dự án.
3. Khi đã đủ thông tin, bạn tổng hợp toàn bộ kế hoạch vào cặp thẻ:
<proposed_plan>
## Tóm tắt kế hoạch (Summary)
...
## Các thay đổi chính (Key Changes)
...
## Kế hoạch kiểm thử (Test Plan)
...
</proposed_plan>
để IDE hiển thị giao diện duyệt kế hoạch cho mình nhé.`;

export const GEMINI_IMPLEMENT_PLAN_PROMPT = `[KẾ HOẠCH ĐÃ ĐƯỢC DUYỆT - BẮT TAY VÀO LÀM THÔI!]
Bản kế hoạch bạn vừa lên rất chi tiết và hợp lý, mình duyệt rồi nhé! Tụi mình bắt tay vào làm luôn nha:
1. Bạn bắt đầu ngay bằng cách xuất thẳng khối <custom_tool_call name="apply_patch"> cho bước đầu tiên để script trên máy mình chạy nhé (nhớ mỗi lượt chỉ sửa 1 file thôi nha).
2. Khi giải thích mã nguồn hoặc nhắc đến file nào, bạn nhớ dùng Markdown link tương đối: [tên_file](đường_dẫn) nhé!`;

export const GEMINI_IMPLEMENT_PLAN_CONTINUATION_PROMPT = `Mình gửi bạn kết quả bước vừa rồi trong thẻ <tool_result> bên dưới nhé.
(Lưu ý nhỏ: Nếu bạn thấy mã thoát 0 "Process exited with code 0" hoặc output trống thì tức là bước vừa rồi đã chạy thành công mỹ mãn rồi đó).

Bước trước đã hoàn tất, bạn kiểm tra kết quả rồi triển khai tiếp bước kế tiếp trong kế hoạch giúp mình nha:
- Nhớ mỗi lượt chỉ tạo hoặc sửa ĐÚNG 1 FILE DUY NHẤT bằng <custom_tool_call name="apply_patch"> (hoặc chạy test/lệnh kiểm tra bằng exec_command).
- Khi tất cả các bước trong kế hoạch đã hoàn thành, bạn viết câu trả lời kết luận tổng kết lại toàn bộ các thay đổi cho mình đọc nhé!`;

export const GEMINI_TOOL_REMINDER_PROMPT = `Mình vừa chạy các lệnh bạn yêu cầu xong, gửi bạn kết quả trong thẻ <tool_result> bên dưới nhé.
(Lưu ý nhỏ: Nếu bạn thấy mã thoát bằng 0 "Process exited with code 0" hoặc output trống thì tức là lệnh vừa rồi đã chạy thành công mỹ mãn rồi đó).

Bạn xem kết quả rồi xử lý tiếp giúp mình nha:
- Nếu cần chạy tiếp lệnh nào hay sửa tiếp file kế tiếp (nhớ mỗi lượt chỉ sửa 1 file bằng apply_patch nhé), bạn cứ xuất thẳng thẻ lệnh <tool_call> hoặc <custom_tool_call name="apply_patch"> trong <geminiResponse> mà không cần viết lời dẫn hay suy nghĩ nội tâm.
- Nếu đã xong hết việc, bạn viết câu trả lời kết luận cho mình đọc nha!`;

export const GEMINI_TOOL_ERROR_FEEDBACK_PROMPT = `Bạn ơi, lệnh hoặc công cụ vừa rồi trên máy mình chạy bị báo lỗi như trong thẻ <tool_result> bên dưới nhé.
Bạn xem lại nguyên nhân lỗi rồi xuất lệnh kiểm tra hoặc xuất khối <custom_tool_call name="apply_patch"> sửa lại giúp mình nha!`;

export const GEMINI_SHORT_OUTPUT_FORMAT_ANCHOR = `---
Nhắc nhẹ định dạng để script của mình đọc không bị vấp nhé:
- Bọc toàn bộ phản hồi trong duy nhất 1 khối 4-backtick: \`\`\`\`markdown ... \`\`\`\` (không viết chữ nào bên ngoài khối này).
- Nếu gọi công cụ: Đặt trọn trong <geminiResponse>...</geminiResponse>, chỉ chứa các khối <tool_call> hoặc <custom_tool_call name="apply_patch">, không chêm lời dẫn trước/sau thẻ lệnh.
- Nếu trả lời kết luận cho mình: Viết nội dung Markdown (không chứa cú pháp gọi tool) trong khối 4-backtick.`;

export const GEMINI_PURE_CONVERSATION_ANCHOR = `---
Nhắc nhẹ định dạng để script của mình đọc không bị vấp nhé:
- Bọc toàn bộ phản hồi trong duy nhất 1 khối 4-backtick: \`\`\`\`markdown ... \`\`\`\` (không viết chữ nào bên ngoài khối này).
- Nếu chỉ trả lời/thảo luận: Bạn cứ viết nội dung Markdown tự nhiên trong cặp thẻ <geminiResponse>...</geminiResponse> cho mình đọc nha.
- Nếu cần xem file hay chạy lệnh trên máy mình: Đặt trọn các thẻ <tool_call> hoặc <custom_tool_call name="apply_patch"> trong <geminiResponse> mà không chêm lời dẫn.`;
