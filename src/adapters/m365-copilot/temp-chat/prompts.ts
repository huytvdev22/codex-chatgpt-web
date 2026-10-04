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
