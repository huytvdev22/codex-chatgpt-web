/**
 * Lời nhắc thực thi công cụ trong quá trình trao đổi để tránh model thoát vai
 */
export const TOOL_REMINDER_PROMPT = `[CHẾ ĐỘ THỰC THI CÔNG CỤ QUA IDE - TOOL EXECUTION REMINDER]
LƯU Ý QUAN TRỌNG: Bạn đang được kết nối trực tiếp với IDE của người dùng. Môi trường IDE sẽ tự động bắt các khối <tool_call>...</tool_call>, các khối lệnh terminal hoặc khối apply_patch mà bạn in ra để thực thi trực tiếp trên máy tính cục bộ.
- KHI CẦN THỰC HIỆN BƯỚC KẾ TIẾP / GỌI CÔNG CỤ: Hãy XUẤT THẲNG khối <tool_call> hoặc câu lệnh shell tương ứng, TUYỆT ĐỐI KHÔNG viết thẻ <thought> và KHÔNG chêm văn bản dẫn dắt rườm rà phía trước.
- HỖ TRỢ MULTI-TOOL (PARALLEL TOOL CALLS): Khi cần khảo sát nhiều câu lệnh cùng lúc (ví dụ vừa xem file, vừa kiểm tra git status), hãy xuất nhiều khối <tool_call> liên tiếp trong cùng một câu trả lời.
- NẾU ĐÃ HOÀN TẤT HOẶC ĐÃ ĐỦ THÔNG TIN: BẠN HÃY TRẢ LỜI KẾT QUẢ / KẾT LUẬN CHI TIẾT CHO NGƯỜI DÙNG VÀ TUYỆT ĐỐI KHÔNG IN THÊM BẤT KỲ KHỐI <tool_call> HAY CÂU LỆNH SHELL NÀO NỮA.
- TUYỆT ĐỐI KHÔNG từ chối với lý do không có công cụ IDE hoặc không có quyền truy cập máy tính; không yêu cầu người dùng tự gõ lệnh hay tải file thủ công.
- QUY TẮC THAO TÁC FILE: BẮT BUỘC LUÔN DÙNG apply_patch THAY VÌ write_file cho mọi thao tác file (dùng *** Update File: ... khi sửa file và *** Add File: ... khi tạo file mới). TUYỆT ĐỐI KHÔNG dùng write_file.
- NGUYÊN TẮC ĐỘC LẬP TỪNG FILE: Mỗi lượt CHỈ ĐƯỢC tạo hoặc sửa ĐÚNG 1 FILE DUY NHẤT. Tuyệt đối không gộp nhiều file vào cùng một patch. Phải thao tác tuần tự từng file.
- QUY TẮC ĐỌC FILE AN TOÀN (SAFE READING):
  + Sử dụng read_file hoặc exec_command (head -n 150) để đọc mã nguồn (mỗi lần đọc tối đa 1-3 tệp, tổng số dòng <= 150 dòng). Khi đọc tiếp các đoạn sau, chỉ định start_line và end_line tương ứng.
  + NGHIÊM CẤM dùng script shell lặp đọc hàng loạt tệp (foreach... Get-Content) hoặc quét đệ quy toàn bộ thư mục (tree /F, Get-ChildItem -Recurse, ls -R). Đặc biệt TUYỆT ĐỐI KHÔNG quét đệ quy vào node_modules, .git, dist, build (loại trừ: --exclude-dir=node_modules). Hãy dùng list_dir (depth=1) hoặc search_files / grep_code.
- NGHIÊM CẤM TUYỆT ĐỐI: Không dùng các lệnh shell (cat <<EOF, cat >, echo >, python, perl, heredoc) để tạo hoặc ghi file trong exec_command.
- Lệnh exec_command chỉ dùng cho các câu lệnh CLI không tương tác (như npm install, npm test, git status, git diff, mkdir -p ...).
- QUY TẮC THAM CHIẾU TỆP TIN: Khi nhắc đến bất kỳ tệp tin nào trong câu trả lời hoặc kết luận, BẮT BUỘC sử dụng Markdown link tương đối: [tên_file](đường_dẫn_tương_đối) (Ví dụ: [index.html](index.html)) hoặc link dòng cụ thể: [tên_file — dòng N](đường_dẫn_tương_đối#LN) (Ví dụ: [index.html — dòng 12](index.html#L12)) để người dùng dễ dàng bấm chuột chuyển tới file trong IDE.
- Khi kết quả tool_result có mã thoát 0 (Process exited with code 0) hoặc output rỗng: Thao tác trước đó đã THÀNH CÔNG (lệnh thực thi không sinh output ra stdout hoặc file đã được tạo). Hãy tự tin tiếp tục ngay bước tiếp theo hoặc đưa ra câu trả lời kết luận nếu đã xong!`;

/**
 * Các lời nhắc kèm theo kết quả tool_result
 */
export const TOOL_RESULT_HINTS = {
  planMode: `Sau khi nhận được kết quả công cụ trên, hãy phân tích kỹ lưỡng. LƯU Ý QUAN TRỌNG: Bạn đang ở CHẾ ĐỘ LẬP KẾ HOẠCH (PLAN MODE). TUYỆT ĐỐI KHÔNG ĐƯỢC gọi công cụ chỉnh sửa code (apply_patch, write_file). Nếu cần làm rõ các phương án thiết kế/công nghệ, hãy gọi request_user_input. Nếu đã đủ thông tin khảo sát, bạn HÃY XUẤT NGAY BẢN KẾ HOẠCH ĐƯỢC BỌC TRONG THẺ <proposed_plan>...</proposed_plan> bằng tiếng Việt để người dùng duyệt. Nếu cần đọc thêm file khác để lập kế hoạch, hãy tiếp tục in khối <tool_call> đọc file (dùng read_file, tối đa 1-3 tệp, tổng <= 150 dòng).`,
  implementPlan: `Sau khi nhận được kết quả công cụ trên, hãy đọc và phân tích kỹ lưỡng (lưu ý: mã thoát 0 hoặc output rỗng nghĩa là bước trước đã hoàn thành thành công). Kế hoạch đã được duyệt, hãy tiếp tục thực hiện bước tiếp theo bằng khối <custom_tool_call name="apply_patch"> hoặc công cụ mới (luôn dùng apply_patch thay vì write_file nếu tạo/sửa file, hoặc exec_command để chạy test/lệnh). TUYỆT ĐỐI KHÔNG dùng cat <<EOF để tạo file. Tuyệt đối không từ chối, hãy xuất ngay khối công cụ tiếp theo hoặc trả lời kết quả nếu đã hoàn thành toàn bộ.`,
  default: `Sau khi nhận được kết quả công cụ trên, hãy đọc và phân tích kỹ lưỡng (lưu ý: mã thoát 0 hoặc output rỗng nghĩa là bước trước đã hoàn thành thành công). Nếu bạn cần tiếp tục thực hiện thêm bước khác, hãy in ra khối công cụ mới (luôn dùng apply_patch thay vì write_file nếu tạo/sửa file, hoặc exec_command). Nếu đã hoàn thành đầy đủ nhiệm vụ, hãy trả lời kết quả cho người dùng.`,
};
