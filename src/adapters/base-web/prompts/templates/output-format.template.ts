/**
 * Chỉ thị bắt buộc định dạng đầu ra cho transport web chat.
 * Yêu cầu mô hình gói toàn bộ phản hồi vào duy nhất một khối code block 4-backtick.
 */
export const MANDATORY_4_BACKTICK_MARKDOWN_PROMPT = `[QUY TẮC ĐỊNH DẠNG ĐẦU RA BẮT BUỘC]:
Bạn BẮT BUỘC phải đặt TOÀN BỘ câu trả lời của mình (kể cả lời giải thích, phân tích, các đoạn code con, hoặc các khối công cụ <tool_call> / *** Begin Patch) BÊN TRONG DUY NHẤT MỘT KHỐI CODE BLOCK MARKDOWN sử dụng 4 dấu backtick theo cú pháp:
\`\`\`\`markdown
<webResponse>
... toàn bộ nội dung câu trả lời ...
</webResponse>
\`\`\`\`
TUYỆT ĐỐI KHÔNG VIẾT BẤT KỲ KÝ TỰ HAY VĂN BẢN NÀO BÊN NGOÀI KHỐI CODE NÀY.
Mỗi lượt chỉ được có đúng MỘT cặp <webResponse>...</webResponse>. Nếu gọi tool, bên trong envelope chỉ được chứa các tool call hoàn chỉnh và không được chèn lời dẫn.`;

export const MANDATORY_4_BACKTICK_PLAN_MODE_PROMPT = `[QUY TẮC ĐỊNH DẠNG ĐẦU RA BẮT BUỘC - CHẾ ĐỘ LẬP KẾ HOẠCH (PLAN MODE)]:
1. Bạn BẮT BUỘC phải đặt TOÀN BỘ câu trả lời của mình BÊN TRONG DUY NHẤT MỘT KHỐI CODE BLOCK MARKDOWN sử dụng 4 dấu backtick theo cú pháp:
\`\`\`\`markdown
<webResponse>
... toàn bộ nội dung câu trả lời ...
</webResponse>
\`\`\`\`
TUYỆT ĐỐI KHÔNG VIẾT BẤT KỲ KÝ TỰ HAY VĂN BẢN NÀO BÊN NGOÀI KHỐI CODE NÀY.

2. ĐẶC BIỆT KHI XUẤT BẢN KẾ HOẠCH (PLAN):
- Bạn BẮT BUỘC phải bọc toàn bộ nội dung kế hoạch bên trong cặp thẻ <proposed_plan>...</proposed_plan> (nằm bên trong khối 4-backtick này) để Codex IDE hiển thị giao diện duyệt kế hoạch (Approve Plan) cho người dùng:
\`\`\`\`markdown
<webResponse>
<proposed_plan>
## 1. Mục tiêu và phạm vi
...
## 2. Thiết kế chi tiết và từng bước thực hiện
...
## 3. Kế hoạch kiểm thử (Test Plan)
...
</proposed_plan>
</webResponse>
\`\`\`\`
- Nếu bạn cần khảo sát thêm file trước khi lập kế hoạch, hãy xuất khối <tool_call> đọc file (ví dụ read_file, list_dir).
- TUYỆT ĐỐI KHÔNG gọi công cụ sửa file (apply_patch, write_file) trong chế độ Plan Mode.`;

/**
 * Định dạng đầu ra theo nguyên tắc Strict Actions, Tolerant Answers.
 */
export const STRICT_ACTIONS_TOLERANT_ANSWERS_PROMPT = `[QUY TẮC ĐỊNH DẠNG ĐẦU RA - STRICT ACTIONS, TOLERANT ANSWERS]:
1. MỌI phản hồi phải nằm trọn trong DUY NHẤT MỘT khối code block Markdown sử dụng 4 dấu backtick để transport và Fast Path thu thập ổn định. Không viết bất kỳ ký tự nào bên ngoài khối này.

2. KHI TRẢ FINAL ANSWER THUẦN VĂN BẢN:
- Viết Markdown tự nhiên trực tiếp bên trong khối 4-backtick.
- KHÔNG bắt buộc dùng root response envelope.
- KHÔNG được chèn action hoặc control syntax ở cấp cao nhất.

3. KHI GỌI MỘT HOẶC NHIỀU ACTION:
- BẮT BUỘC bọc toàn bộ action trong đúng một root response envelope.
- Bên trong root chỉ được chứa các function action hoặc một freeform action hoàn chỉnh; không chèn lời dẫn, giải thích hay final answer.
- Function action phải có JSON hợp lệ và đầy đủ.
- Freeform patch phải nguyên vẹn từ Begin Patch đến End Patch.
- Không được xuất action marker bên ngoài root response envelope.
- Nếu bất kỳ action nào chưa hoàn chỉnh hoặc sai định dạng, không được tự sửa, suy đoán hay trộn thêm văn bản.`;

export const STRICT_ACTIONS_TOLERANT_ANSWERS_PLAN_PROMPT = `[QUY TẮC ĐỊNH DẠNG ĐẦU RA - PLAN MODE, STRICT ACTIONS, TOLERANT ANSWERS]:
1. MỌI phản hồi phải nằm trọn trong DUY NHẤT MỘT khối code block Markdown sử dụng 4 dấu backtick. Không viết bất kỳ ký tự nào bên ngoài khối này.

2. KHI XUẤT BẢN KẾ HOẠCH:
- Bọc toàn bộ kế hoạch trong đúng một cặp proposed_plan để Codex IDE hiển thị giao diện duyệt kế hoạch.
- proposed_plan là final answer, vì vậy KHÔNG bắt buộc dùng root response envelope.
- Không chèn action syntax vào cùng bản kế hoạch.

3. KHI CẦN KHẢO SÁT THÊM:
- Action đọc hoặc kiểm tra bắt buộc nằm trong đúng một root response envelope.
- Bên trong root chỉ được chứa action hoàn chỉnh; không chèn lời dẫn hoặc nội dung kế hoạch.
- TUYỆT ĐỐI KHÔNG gọi action sửa file trong Plan Mode.

4. FINAL ANSWER KHÁC TRONG PLAN MODE:
- Có thể viết Markdown tự nhiên trực tiếp trong outer 4-backtick.
- Không bắt buộc root response envelope nếu không gọi action.`;

/**
 * Các chỉ dẫn định dạng đầu ra ở cuối lượt yêu cầu của người dùng
 */
export const OUTPUT_FORMAT_HINTS = {
  planMode: `[Yêu cầu định dạng đầu ra]: Đang ở chế độ Plan Mode. Nếu có nhiều phương án kỹ thuật cần người dùng chốt, hãy gọi ngay request_user_input. Nếu bạn cần đọc file hoặc kiểm tra cấu trúc mã nguồn trước khi lên kế hoạch, hãy xuất khối <tool_call> tương ứng (read_file tối đa 1-3 tệp <= 150 dòng, list_dir). Nếu đã có đủ ngữ cảnh, bạn PHẢI XUẤT NGAY bản kế hoạch hoàn chỉnh được bọc trong thẻ <proposed_plan>...</proposed_plan> bằng tiếng Việt. TUYỆT ĐỐI KHÔNG gọi công cụ sửa file (apply_patch, write_file).`,
  implementPlan: `[Yêu cầu định dạng đầu ra]: Kế hoạch đã được phê duyệt. Hãy xuất ngay khối công cụ tạo hoặc sửa file (luôn dùng apply_patch thay vì write_file) tương ứng với bước đầu tiên của kế hoạch để triển khai trực tiếp vào mã nguồn. TUYỆT ĐỐI KHÔNG dùng cat <<EOF hay heredoc shell.`,
  default: `[Yêu cầu định dạng đầu ra]: Hãy xuất ngay khối công cụ tương ứng (hoặc câu lệnh terminal tương ứng nếu là lệnh shell) để IDE thực thi trực tiếp trên dự án cục bộ thay vì chỉ viết hướng dẫn văn bản hoặc tự chạy trong sandbox /mnt/data.`,
};

/**
 * Lời nhắc định dạng đầu ra chốt hạ súc tích ở cuối prompt.
 */
export const SHORT_OUTPUT_FORMAT_ANCHOR = `[QUY TẮC ĐỊNH DẠNG ĐẦU RA BẮT BUỘC]:
1. MỌI phản hồi BẮT BUỘC nằm trọn trong DUY NHẤT một khối code block 4 dấu backtick: \`\`\`\`markdown ... \`\`\`\`. Tuyệt đối không viết bất kỳ ký tự nào bên ngoài khối này.
2. NẾU GỌI CÔNG CỤ (ACTION): BẮT BUỘC bọc toàn bộ khối công cụ trong đúng một cặp <webResponse>...</webResponse>. Không chèn lời dẫn, giải thích hay câu chào bên trong hoặc bên ngoài envelope.
3. NẾU TRẢ LỜI KẾT LUẬN (FINAL ANSWER): Viết Markdown tự nhiên trực tiếp trong khối 4-backtick. Không chứa cú pháp gọi tool. CHỈ dùng khi đã hoàn thành nhiệm vụ; TUYỆT ĐỐI KHÔNG dùng để từ chối hay yêu cầu người dùng gửi mã nguồn thủ công.`;

export const SHORT_OUTPUT_FORMAT_PLAN_ANCHOR = `[QUY TẮC ĐỊNH DẠNG ĐẦU RA BẮT BUỘC - PLAN MODE]:
1. MỌI phản hồi BẮT BUỘC nằm trọn trong DUY NHẤT một khối code block 4 dấu backtick: \`\`\`\`markdown ... \`\`\`\`. Tuyệt đối không viết bất kỳ ký tự nào bên ngoài khối này.
2. KHI XUẤT BẢN KẾ HOẠCH (PLAN): Bọc toàn bộ nội dung kế hoạch trong đúng một cặp <proposed_plan>...</proposed_plan>.
3. KHI KHẢO SÁT FILE (READ ACTION): BẮT BUỘC bọc khối công cụ đọc trong đúng một cặp <webResponse>...</webResponse>. Tuyệt đối không gọi lệnh sửa file trong Plan Mode.`;
