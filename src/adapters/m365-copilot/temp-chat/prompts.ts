/**
 * Chỉ thị bắt buộc định dạng đầu ra cho chế độ Temporary Chat Per Request
 * Yêu cầu M365 Copilot gói toàn bộ phản hồi vào duy nhất 1 khối code block 4-backtick ````markdown
 */
export const MANDATORY_4_BACKTICK_MARKDOWN_PROMPT = `[QUY TẮC ĐỊNH DẠNG ĐẦU RA BẮT BUỘC]:
Bạn BẮT BUỘC phải đặt TOÀN BỘ câu trả lời của mình (kể cả lời giải thích, phân tích, các đoạn code con, hoặc các khối công cụ <tool_call> / *** Begin Patch) BÊN TRONG DUY NHẤT MỘT KHỐI CODE BLOCK MARKDOWN sử dụng 4 dấu backtick theo cú pháp:
\`\`\`\`markdown
... toàn bộ nội dung câu trả lời ...
\`\`\`\`
TUYỆT ĐỐI KHÔNG VIẾT BẤT KỲ KÝ TỰ HAY VĂN BẢN NÀO BÊN NGOÀI KHỐI CODE NÀY.`;

export const MANDATORY_4_BACKTICK_PLAN_MODE_PROMPT = `[QUY TẮC ĐỊNH DẠNG ĐẦU RA BẮT BUỘC - CHẾ ĐỘ LẬP KẾ HOẠCH (PLAN MODE)]:
1. Bạn BẮT BUỘC phải đặt TOÀN BỘ câu trả lời của mình BÊN TRONG DUY NHẤT MỘT KHỐI CODE BLOCK MARKDOWN sử dụng 4 dấu backtick theo cú pháp:
\`\`\`\`markdown
... toàn bộ nội dung câu trả lời ...
\`\`\`\`
TUYỆT ĐỐI KHÔNG VIẾT BẤT KỲ KÝ TỰ HAY VĂN BẢN NÀO BÊN NGOÀI KHỐI CODE NÀY.

2. ĐẶC BIỆT KHI XUẤT BẢN KẾ HOẠCH (PLAN):
- Bạn BẮT BUỘC phải bọc toàn bộ nội dung kế hoạch bên trong cặp thẻ <proposed_plan>...</proposed_plan> (nằm bên trong khối 4-backtick này) để Codex IDE hiển thị giao diện duyệt kế hoạch (Approve Plan) cho người dùng:
\`\`\`\`markdown
<proposed_plan>
## 1. Mục tiêu và phạm vi
...
## 2. Thiết kế chi tiết và từng bước thực hiện
...
## 3. Kế hoạch kiểm thử (Test Plan)
...
</proposed_plan>
\`\`\`\`
- Nếu bạn cần khảo sát thêm file trước khi lập kế hoạch, hãy xuất khối <tool_call> đọc file (ví dụ read_file, list_dir).
- TUYỆT ĐỐI KHÔNG gọi công cụ sửa file (apply_patch, write_file) trong chế độ Plan Mode.`;
