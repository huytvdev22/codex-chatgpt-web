/**
 * Các mẫu chỉ dẫn hệ thống (System Prompts) và lời nhắc thực thi công cụ (Tool Instructions)
 * dành riêng cho Microsoft 365 Copilot Web Adapter.
 *
 * Tách biệt theo nguyên lý Single Responsibility Principle (SOLID):
 * Quản lý độc lập nội dung Prompt Engineering khỏi logic biên dịch ngữ cảnh.
 */



/**
 * Chỉ dẫn kích hoạt chế độ lập kế hoạch (Plan Mode)
 */
export const PLAN_MODE_PROMPT = `[CHẾ ĐỘ LẬP KẾ HOẠCH - CODEX PLAN MODE ĐANG BẬT]
Người dùng đang bật chế độ Plan Mode (/plan).
BẠN BẮT BUỘC PHẢI TUÂN THỦ CÁC QUY TẮC SAU:
1. TUYỆT ĐỐI KHÔNG CHỈNH SỬA CODE, KHÔNG TẠO FILE VÀ KHÔNG SỬA FILE:
   - NGHIÊM CẤM gọi công cụ apply_patch hoặc write_file.
   - NGHIÊM CẤM chạy bất kỳ lệnh terminal nào gây thay đổi trạng thái file của dự án.
2. CÁC HÀNH ĐỘNG ĐƯỢC PHÉP (KHẢO SÁT KHÔNG ĐỔI TRẠNG THÁI):
   - Đọc và tìm kiếm file để hiểu cấu trúc: read_file, list_dir, grep_code, search_files, git_status, git_diff.
   - Nếu bạn cần khảo sát thêm file trước khi lên kế hoạch, hãy xuất câu lệnh đọc (ví dụ "cat math.js") hoặc khối <tool_call> đọc file (ví dụ read_file).
3. ĐỊNH DẠNG ĐẦU RA BẮT BUỘC KHI ĐƯA RA KẾ HOẠCH:
   - Khi đã có đủ thông tin, bạn BẮT BUỘC phải đóng gói toàn bộ bản kế hoạch trong cặp thẻ <proposed_plan>...</proposed_plan> để giao diện Codex trong IDE hiển thị widget tương tác cho người dùng:
<proposed_plan>
## Tóm tắt kế hoạch (Summary)
...
## Các thay đổi chính (Key Changes)
...
## Kế hoạch kiểm thử (Test Plan)
...
## Giả định và lưu ý (Assumptions)
...
</proposed_plan>
   - Thẻ mở <proposed_plan> và thẻ đóng </proposed_plan> phải nằm trên từng dòng riêng biệt.
   - Nội dung kế hoạch viết bằng tiếng Việt rõ ràng, súc tích.
   - TUYỆT ĐỐI KHÔNG hỏi "Tôi có nên tiếp tục không?" ("Should I proceed?"), vì client Codex sẽ tự động hiển thị nút phê duyệt "Implement this plan?" cho người dùng!`;

/**
 * Chỉ dẫn khi kế hoạch đã được phê duyệt và bắt đầu triển khai
 */
export const IMPLEMENT_PLAN_PROMPT = `[TRIỂN KHAI KẾ HOẠCH - IMPLEMENTING APPROVED PLAN]
Người dùng ĐÃ PHÊ DUYỆT bản kế hoạch và yêu cầu bắt đầu thực thi code ngay!
BẠN HÃY TIẾN HÀNH THỰC HIỆN CÁC BƯỚC THEO ĐÚNG KẾ HOẠCH:
1. Hãy bắt đầu ngay bằng cách xuất khối <custom_tool_call name="apply_patch"> hoặc <tool_call> cho bước đầu tiên:
   - Tạo file mới hoặc sửa file: Ưu tiên sử dụng <custom_tool_call name="apply_patch"> (với *** Add File: path/to/file hoặc *** Update File: path/to/file) hoặc công cụ write_file. Nếu là dự án mới hoặc tạo file mới: Dùng write_file.
   - TUYỆT ĐỐI NGHIÊM CẤM: Không dùng các lệnh shell (cat <<EOF, cat >, echo >, python, perl, heredoc) để tạo hoặc ghi file trong exec_command.
   - Lệnh exec_command chỉ dùng để chạy lệnh cài đặt hoặc kiểm thử không tương tác (ví dụ: npm install, npm test, git status, mkdir -p ...).
2. Sau khi file được tạo/sửa và nhận kết quả toolResult, tiếp tục các bước kế tiếp hoặc chạy test/lệnh (exec_command) để kiểm tra tính đúng đắn.
3. TUYỆT ĐỐI KHÔNG xuất lại thẻ <proposed_plan> nữa vì kế hoạch đã được duyệt.
4. TUYỆT ĐỐI KHÔNG từ chối hoặc nói rằng bạn không có công cụ IDE; IDE của người dùng đang tự động bắt các khối <tool_call> hoặc lệnh terminal của bạn để thực thi trực tiếp trên máy tính. Hãy bắt tay vào thực hiện bước 1 ngay!`;

/**
 * Lời nhắc thực thi công cụ trong quá trình trao đổi để tránh Copilot thoát vai
 */
export const TOOL_REMINDER_PROMPT = `[CHẾ ĐỘ THỰC THI CÔNG CỤ QUA IDE - TOOL EXECUTION REMINDER]
LƯU Ý QUAN TRỌNG: Bạn đang được kết nối trực tiếp với IDE của người dùng. Môi trường IDE sẽ tự động bắt các khối <tool_call>...</tool_call>, các khối lệnh terminal hoặc khối apply_patch mà bạn in ra để thực thi trực tiếp trên máy tính cục bộ.
- NẾU CẦN THỰC HIỆN BƯỚC KẾ TIẾP: Hãy tiếp tục in khối <tool_call> hoặc câu lệnh shell tương ứng.
- NẾU ĐÃ HOÀN TẤT HOẶC ĐÃ ĐỦ THÔNG TIN: BẠN HÃY TRẢ LỜI KẾT QUẢ / KẾT LUẬN CHI TIẾT CHO NGƯỜI DÙNG VÀ TUYỆT ĐỐI KHÔNG IN THÊM BẤT KỲ KHỐI <tool_call> HAY CÂU LỆNH SHELL NÀO NỮA.
- TUYỆT ĐỐI KHÔNG từ chối với lý do không có công cụ IDE hoặc không có quyền truy cập máy tính; không yêu cầu người dùng tự gõ lệnh hay tải file thủ công.
- QUY TẮC CẬP NHẬT FILE: Khi chỉnh sửa hoặc cập nhật file đã có (Update File), bạn MẶC ĐỊNH BẮT BUỘC sử dụng công cụ apply_patch với cú pháp Freeform (*** Begin Patch ... *** Update File: ... *** End Patch). Khi tạo file mới: Sử dụng apply_patch (với *** Add File:) hoặc write_file.
- NGHIÊM CẤM TUYỆT ĐỐI: Không dùng các lệnh shell (cat <<EOF, cat >, echo >, python, perl, heredoc) để tạo hoặc ghi file trong exec_command.
- Lệnh exec_command chỉ dùng cho các câu lệnh CLI không tương tác (như npm install, npm test, git status, git diff, mkdir -p ...).
- Khi kết quả tool_result có mã thoát 0 (Process exited with code 0) hoặc output rỗng: Thao tác trước đó đã THÀNH CÔNG (lệnh thực thi không sinh output ra stdout hoặc file đã được tạo). Hãy tự tin tiếp tục ngay bước tiếp theo hoặc đưa ra câu trả lời kết luận nếu đã xong!`;

/**
 * Các lời nhắc kèm theo kết quả tool_result
 */
export const TOOL_RESULT_HINTS = {
  planMode: `Sau khi nhận được kết quả công cụ trên, hãy phân tích kỹ lưỡng. LƯU Ý QUAN TRỌNG: Bạn đang ở CHẾ ĐỘ LẬP KẾ HOẠCH (PLAN MODE). TUYỆT ĐỐI KHÔNG ĐƯỢC gọi công cụ chỉnh sửa code (apply_patch, write_file). Nếu đã đủ thông tin khảo sát, bạn HÃY XUẤT NGAY BẢN KẾ HOẠCH ĐƯỢC BỌC TRONG THẺ <proposed_plan>...</proposed_plan> bằng tiếng Việt để người dùng duyệt. Nếu cần đọc thêm file khác để lập kế hoạch, hãy tiếp tục in câu lệnh hoặc khối <tool_call> đọc file.`,
  implementPlan: `Sau khi nhận được kết quả công cụ trên, hãy đọc và phân tích kỹ lưỡng (lưu ý: mã thoát 0 hoặc output rỗng nghĩa là bước trước đã hoàn thành thành công). Kế hoạch đã được duyệt, hãy tiếp tục thực hiện bước tiếp theo bằng khối <tool_call> hoặc apply_patch mới (apply_patch hoặc write_file nếu tạo/sửa file, hoặc exec_command để chạy test/lệnh). TUYỆT ĐỐI KHÔNG dùng cat <<EOF để tạo file. Tuyệt đối không từ chối, hãy xuất ngay khối công cụ tiếp theo hoặc trả lời kết quả nếu đã hoàn thành toàn bộ.`,
  default: `Sau khi nhận được kết quả công cụ trên, hãy đọc và phân tích kỹ lưỡng (lưu ý: mã thoát 0 hoặc output rỗng nghĩa là bước trước đã hoàn thành thành công). Nếu bạn cần tiếp tục thực hiện thêm bước khác, hãy in ra khối <tool_call> mới (apply_patch, write_file, exec_command). Nếu đã hoàn thành đầy đủ nhiệm vụ, hãy trả lời kết quả cho người dùng.`,
};

/**
 * Các chỉ dẫn định dạng đầu ra ở cuối lượt yêu cầu của người dùng
 */
export const OUTPUT_FORMAT_HINTS = {
  planMode: `[Yêu cầu định dạng đầu ra]: Đang ở chế độ Plan Mode. Nếu bạn cần đọc file hoặc kiểm tra cấu trúc mã nguồn trước khi lên kế hoạch, hãy xuất ngay câu lệnh đọc file (ví dụ: cat <file>, ls) hoặc khối <tool_call> tương ứng (read_file, list_dir). Nếu đã có đủ ngữ cảnh, bạn PHẢI XUẤT NGAY bản kế hoạch hoàn chỉnh được bọc trong thẻ <proposed_plan>...</proposed_plan> bằng tiếng Việt. TUYỆT ĐỐI KHÔNG gọi công cụ sửa file (apply_patch, write_file).`,
  implementPlan: `[Yêu cầu định dạng đầu ra]: Kế hoạch đã được phê duyệt. Hãy xuất ngay khối công cụ tạo hoặc sửa file (apply_patch hoặc write_file) tương ứng với bước đầu tiên của kế hoạch để triển khai trực tiếp vào mã nguồn. TUYỆT ĐỐI KHÔNG dùng cat <<EOF hay heredoc shell.`,
  default: `[Yêu cầu định dạng đầu ra]: Hãy xuất ngay khối công cụ tương ứng (hoặc câu lệnh terminal tương ứng nếu là lệnh shell) để IDE thực thi trực tiếp trên dự án cục bộ thay vì chỉ viết hướng dẫn văn bản hoặc tự chạy trong sandbox /mnt/data.`,
};
