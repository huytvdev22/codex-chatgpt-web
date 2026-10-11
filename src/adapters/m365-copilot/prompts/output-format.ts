/**
 * Chỉ thị bắt buộc định dạng đầu ra cho transport M365.
 * Yêu cầu M365 Copilot gói toàn bộ phản hồi vào duy nhất một khối code block 4-backtick.
 */
export const MANDATORY_4_BACKTICK_MARKDOWN_PROMPT = `[QUY TẮC ĐỊNH DẠNG ĐẦU RA BẮT BUỘC]:
Bạn BẮT BUỘC phải đặt TOÀN BỘ câu trả lời của mình (kể cả lời giải thích, phân tích, các đoạn code con, hoặc các khối công cụ &lt;tool_call&gt; / *** Begin Patch) BÊN TRONG DUY NHẤT MỘT KHỐI CODE BLOCK MARKDOWN sử dụng 4 dấu backtick theo cú pháp:
\`\`\`\`markdown
&lt;m365Response&gt;
... toàn bộ nội dung câu trả lời ...
&lt;/m365Response&gt;
\`\`\`\`
TUYỆT ĐỐI KHÔNG VIẾT BẤT KỲ KÝ TỰ HAY VĂN BẢN NÀO BÊN NGOÀI KHỐI CODE NÀY.
Mỗi lượt chỉ được có đúng MỘT cặp &lt;m365Response&gt;...&lt;/m365Response&gt;. Nếu gọi tool, bên trong envelope chỉ được chứa các tool call hoàn chỉnh và không được chèn lời dẫn.`;

export const MANDATORY_4_BACKTICK_PLAN_MODE_PROMPT = `[QUY TẮC ĐỊNH DẠNG ĐẦU RA BẮT BUỘC - CHẾ ĐỘ LẬP KẾ HOẠCH (PLAN MODE)]:
1. Bạn BẮT BUỘC phải đặt TOÀN BỘ câu trả lời của mình BÊN TRONG DUY NHẤT MỘT KHỐI CODE BLOCK MARKDOWN sử dụng 4 dấu backtick theo cú pháp:
\`\`\`\`markdown
&lt;m365Response&gt;
... toàn bộ nội dung câu trả lời ...
&lt;/m365Response&gt;
\`\`\`\`
TUYỆT ĐỐI KHÔNG VIẾT BẤT KỲ KÝ TỰ HAY VĂN BẢN NÀO BÊN NGOÀI KHỐI CODE NÀY.

2. ĐẶC BIỆT KHI XUẤT BẢN KẾ HOẠCH (PLAN):
- Bạn BẮT BUỘC phải bọc toàn bộ nội dung kế hoạch bên trong cặp thẻ &lt;proposed_plan&gt;...&lt;/proposed_plan&gt; (nằm bên trong khối 4-backtick này) để Codex IDE hiển thị giao diện duyệt kế hoạch (Approve Plan) cho người dùng:
\`\`\`\`markdown
&lt;m365Response&gt;
&lt;proposed_plan&gt;
## 1. Mục tiêu và phạm vi
...
## 2. Thiết kế chi tiết và từng bước thực hiện
...
## 3. Kế hoạch kiểm thử (Test Plan)
...
&lt;/proposed_plan&gt;
&lt;/m365Response&gt;
\`\`\`\`
- Nếu bạn cần khảo sát thêm file trước khi lập kế hoạch, hãy xuất khối &lt;tool_call&gt; đọc file (ví dụ read_file, list_dir).
- TUYỆT ĐỐI KHÔNG gọi công cụ sửa file (apply_patch, write_file) trong chế độ Plan Mode.`;
