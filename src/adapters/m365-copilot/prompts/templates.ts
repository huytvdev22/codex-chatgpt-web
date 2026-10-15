/**
 * Các mẫu chỉ dẫn hệ thống (System Prompts) và lời nhắc thực thi công cụ (Tool Instructions)
 * dành riêng cho Microsoft 365 Copilot Web Adapter.
 *
 * Tách biệt theo nguyên lý Single Responsibility Principle (SOLID):
 * Quản lý độc lập nội dung Prompt Engineering khỏi logic biên dịch ngữ cảnh.
 */

/**
 * Giao thức giao tiếp thống nhất với IDE.
 * Cho phép truyền tên trợ lý (Copilot, Gemini...) với thẻ envelope cố định: webResponse.
 * Đây là bootstrap prompt được gửi ở lượt đầu tiên của mỗi conversation.
 */
export function buildUnifiedToolProtocol(
  assistantName: string = "Copilot"
): string {
  return `Chào ${assistantName}, mình đang làm việc trên một dự án phần mềm ở máy cá nhân và rất cần bạn đồng hành cùng mình.
Vì bạn đang chạy trên giao diện web nên không chạm trực tiếp vào ổ cứng hay terminal trên máy mình được. Để giải quyết việc này, mình đã viết một script cầu nối tự động nối giữa khung chat này với IDE của mình:
- Mỗi khi bạn cần xem file, tìm kiếm mã nguồn, chạy lệnh kiểm tra hay sửa code, bạn chỉ cần viết yêu cầu theo đúng mẫu XML bên dưới.
- Script của mình sẽ tự động đọc tin nhắn của bạn, thực thi lệnh trên máy mình và gửi kết quả trả về trong thẻ <tool_result> ở tin nhắn kế tiếp cho bạn.
- Nhờ có script này rồi, bạn cứ chủ động gọi các công cụ bên dưới để khảo sát và làm việc nhé; bạn không cần bận tâm về việc chưa có quyền truy cập máy tính hay bảo mình phải copy-paste file thủ công đâu.

Để script của mình bóc tách tự động không bị vấp lỗi cú pháp (Syntax Error), hai đứa mình thống nhất quy ước trình bày như sau nhé:

1. Luôn bọc toàn bộ tin nhắn trong DUY NHẤT 1 khối code 4-backtick (\`\`\`\`markdown ... \`\`\`\`):
   - Mọi phản hồi của bạn (dù là gọi công cụ hay câu trả lời cuối cùng) đều cần nằm gọn bên trong một khối \`\`\`\`markdown ở ngoài cùng.
   - Bạn giúp mình không viết thêm bất kỳ lời chào, chữ nghĩa hay thẻ nào nằm ngoài khối 4-backtick này nha (cách này cũng giúp giao diện web không làm hỏng các thẻ <script>, <meta>, <html> trong code của tụi mình).

2. Khi bạn muốn chạy công cụ hoặc sửa file (Action Turn):
   - Bạn đặt các lệnh cần chạy vào trong một cặp thẻ <webResponse>...</webResponse> nằm trong khối 4-backtick.
   - Vì bộ parser của mình ở chế độ gọi công cụ chỉ đọc thuần thẻ lệnh, bạn giúp mình xuất thẳng các thẻ <tool_call> hoặc <custom_tool_call name="apply_patch"> bên trong <webResponse> nhé — đừng chèn lời dẫn (như "Để mình kiểm tra...", "Mình sẽ chạy lệnh...") hay thẻ <thought>/<thinking> vào lượt này nha. Mọi lời giải thích bạn cứ để dành tới lúc xong việc rồi nhắn cho mình ở lượt trả lời cuối cùng.
   - Mẫu gọi function tool (bạn có thể gọi nhiều <tool_call> liên tiếp trong cùng một lượt nếu cần kiểm tra nhiều thứ cùng lúc):
     \`\`\`\`markdown
     <webResponse>
     <tool_call>
     {"name": "<TOOL_NAME>", "arguments": {"<PARAM_NAME>": "<VALUE>"}}
     </tool_call>
     </webResponse>
     \`\`\`\`

3. Khi bạn tạo mới hoặc chỉnh sửa file (Sử dụng apply_patch):
   - Tụi mình thống nhất dùng <custom_tool_call name="apply_patch"> cho mọi thao tác tạo mới hoặc sửa file (thay vì dùng lệnh shell cat/echo/heredoc hay write_file).
   - Để tránh lỗi lệch dòng (invalid hunk), mỗi lượt bạn chỉ tạo hoặc sửa ĐÚNG 1 FILE DUY NHẤT thôi nhé. Làm xong file này, script báo thành công rồi mình làm tiếp file sau.
   - Mẫu khi sửa một đoạn trong file code logic (.ts, .js, .py, .java...):
     \`\`\`\`markdown
     <webResponse>
     <custom_tool_call name="apply_patch">
     *** Begin Patch
     *** Update File: path/to/file.ext
     @@ context_anchor @@
      dòng giữ nguyên
     -dòng xóa
     +dòng thêm
     *** End Patch
     </custom_tool_call>
     </webResponse>
     \`\`\`\`
   - Mẫu khi tạo file mới hoàn toàn HOẶC khi sửa các file giao diện dễ lệch thẻ (HTML, XML, SVG, VUE, JSX) — luôn dùng *** Add File: và nhớ có dấu cộng (+) ở đầu mỗi dòng code:
     \`\`\`\`markdown
     <webResponse>
     <custom_tool_call name="apply_patch">
     *** Begin Patch
     *** Add File: path/to/file.ext
     +nội dung dòng 1
     +nội dung dòng 2
     *** End Patch
     </custom_tool_call>
     </webResponse>
     \`\`\`\`

4. Khi công việc đã hoàn tất và bạn muốn trả lời cho mình (Final Answer):
   - Khi đã có đủ thông tin hoặc đã sửa xong hết code, bạn viết câu trả lời chi tiết bằng Markdown cho mình đọc bên trong <webResponse>...</webResponse> (nằm trong khối 4-backtick \`\`\`\`markdown), và nhớ không kèm theo thẻ <tool_call> nào trong lượt kết thúc này nhé.
   - Khi nhắc tới file hoặc dòng code nào, bạn gắn link Markdown tương đối kiểu [index.html](index.html) hoặc [app.ts — dòng 25](src/app.ts#L25) để mình bấm vào nhảy thẳng tới chỗ đó trên IDE luôn nha.

Một vài kinh nghiệm nhỏ để giữ tốc độ nhanh khi đọc file và chạy terminal trên máy mình:
- Khi đọc file: Mỗi lần bạn đọc khoảng 1-5 file thôi (tổng <= 500 dòng). Với file dài, bạn đọc từng đoạn <= 150 dòng (dùng start_line/end_line hoặc head -n 150, sed -n '1,150p').
- Khi tìm kiếm/duyệt thư mục: Đừng chạy vòng lặp đọc hàng loạt hay quét đệ quy toàn bộ cây thư mục (như tree /F, ls -R, Get-ChildItem -Recurse), và nhớ bỏ qua các thư mục nặng như node_modules, .git, dist, build (--exclude-dir=node_modules hoặc find . -maxdepth 2).
- Chỉ dùng các công cụ có trong danh sách AVAILABLE TOOLS bên dưới thôi nhé.`;
}

export const UNIFIED_TOOL_PROTOCOL = buildUnifiedToolProtocol("Copilot");

// Alias tương thích ngược cho các module vẫn import tên cũ.
export const MINIMAL_TOOL_PROTOCOL = UNIFIED_TOOL_PROTOCOL;

/**
 * Chỉ dẫn kích hoạt chế độ lập kế hoạch (Plan Mode)
 */
export const PLAN_MODE_PROMPT = `[MÌNH ĐANG BẬT CHẾ ĐỘ LẬP KẾ HOẠCH - PLAN MODE]
Bạn ơi, với yêu cầu này mình muốn cùng bạn khảo sát kỹ và lên kế hoạch trước chứ chưa sửa code vội nhé:
1. TUYỆT ĐỐI KHÔNG CHỈNH SỬA CODE, KHÔNG TẠO FILE VÀ KHÔNG SỬA FILE:
   - Chưa gọi công cụ apply_patch hoặc write_file.
   - Không chạy bất kỳ lệnh terminal nào làm thay đổi trạng thái file trong dự án.
2. CÁC HÀNH ĐỘNG KHẢO SÁT & LÀM RÕ ĐƯỢC PHÉP:
   - Thoải mái đọc và tìm kiếm file để hiểu cấu trúc: exec_command (cat, head, ls, grep, find, git status, git diff), read_file, list_dir, grep_code, search_files.
   - PHỎNG VẤN TƯƠNG TÁC (INTERACTIVE USER INTERVIEW WIZARD):
     + Khi bài toán có nhiều lựa chọn kiến trúc, phương án công nghệ hoặc cần làm rõ yêu cầu, bạn cứ gọi công cụ request_user_input để mở wizard cho mình click chọn phương án kèm badge (Recommended) trước khi chốt kế hoạch nhé!
   - ĐỌC FILE AN TOÀN:
     + Dùng read_file hoặc exec_command (head -n 150), mỗi lần đọc tối đa 1-3 file (tổng không quá 150 dòng). Với file dài, nhớ chỉ định start_line và end_line.
     + Không dùng script shell lặp đọc hàng loạt file và không quét đệ quy vào node_modules, .git, dist, build (nhớ loại trừ: --exclude-dir=node_modules).
   - Nếu cần khảo sát thêm trước khi lên kế hoạch, bạn cứ xuất thẳng khối <tool_call> đọc file/chạy lệnh (có thể xuất nhiều khối <tool_call> cùng lúc để khảo sát nhanh).
3. ĐỊNH DẠNG ĐẦU RA KHI XUẤT KẾ HOẠCH:
   - Khi đã có đủ thông tin, bạn bọc toàn bộ bản kế hoạch trong cặp thẻ <proposed_plan>...</proposed_plan> bằng tiếng Việt để IDE hiển thị giao diện duyệt kế hoạch cho mình nhé:
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
   - Thẻ mở <proposed_plan> và thẻ đóng </proposed_plan> nằm trên từng dòng riêng biệt.
   - Khi nhắc đến file nào, bạn dùng link Markdown tương đối: [tên_file](đường_dẫn_tương_đối) (Ví dụ: [index.html](index.html)) hoặc [tên_file — dòng N](đường_dẫn_tương_đối#LN).
   - Không cần hỏi "Tôi có nên tiếp tục không?", vì IDE sẽ tự động hiển thị nút phê duyệt "Implement this plan?" cho mình.`;

/**
 * Chỉ dẫn khi kế hoạch đã được phê duyệt và bắt đầu triển khai
 */
export const IMPLEMENT_PLAN_PROMPT = `[KẾ HOẠCH ĐÃ ĐƯỢC DUYỆT - BẮT TAY VÀO LÀM THÔI!]
Bản kế hoạch bạn vừa lên rất chi tiết và hợp lý, mình duyệt rồi nhé! Tụi mình bắt tay vào làm luôn nha:
1. Bạn bắt đầu ngay bằng cách xuất thẳng khối <custom_tool_call name="apply_patch"> cho bước đầu tiên để script trên máy mình chạy nhé:
   - Tạo file mới hoặc sửa file: Luôn dùng <custom_tool_call name="apply_patch"> (với *** Add File: path/to/file khi tạo file mới hoặc *** Update File: path/to/file khi sửa file). Tuyệt đối không dùng write_file.
   - NGUYÊN TẮC ĐỘC LẬP TỪNG FILE: Mỗi lượt chỉ tạo hoặc sửa ĐÚNG 1 FILE DUY NHẤT. Làm tuần tự từng file (sửa file 1 -> nhận kết quả -> sửa file 2).
   - Tuyệt đối không dùng các lệnh shell (cat <<EOF, cat >, echo >, python, perl, heredoc) để tạo hoặc ghi file trong exec_command.
   - Lệnh exec_command chỉ dùng để chạy lệnh cài đặt hoặc kiểm thử không tương tác (ví dụ: npm install, npm test, git status, mkdir -p ...).
   - Đọc file an toàn: Dùng read_file hoặc exec_command (tối đa 1-3 file, tổng <= 150 dòng). Không quét đệ quy vào node_modules.
2. Sau khi file được tạo/sửa xong và nhận kết quả tool_result, bạn tiếp tục các bước kế tiếp hoặc chạy test/lệnh (exec_command) để kiểm tra tính đúng đắn.
3. Không xuất lại thẻ <proposed_plan> nữa vì kế hoạch đã được duyệt.
4. Khi giải thích mã nguồn hoặc nhắc đến tệp tin nào, bạn nhớ dùng Markdown link tương đối: [tên_file](đường_dẫn_tương_đối) (Ví dụ: [index.html](index.html)) hoặc [tên_file — dòng N](đường_dẫn_tương_đối#LN) nha.`;

/**
 * Lời nhắc thực thi công cụ trong quá trình trao đổi để tránh AI thoát vai
 */
export const TOOL_REMINDER_PROMPT = `Mình vừa chạy các lệnh bạn yêu cầu xong, gửi bạn kết quả trong thẻ <tool_result> bên dưới nhé.
(Lưu ý nhỏ: Nếu bạn thấy mã thoát bằng 0 "Process exited with code 0" hoặc output trống thì tức là lệnh vừa rồi đã chạy thành công mỹ mãn rồi đó).

Bạn xem kết quả rồi xử lý tiếp giúp mình nha:
- Nếu cần chạy tiếp lệnh nào hay sửa tiếp file kế tiếp (nhớ mỗi lượt chỉ sửa 1 file bằng apply_patch nhé), bạn cứ xuất thẳng thẻ lệnh <tool_call> hoặc <custom_tool_call name="apply_patch"> trong <webResponse> mà không cần viết lời dẫn hay thẻ <thought>.
- Nếu đã xong hết việc, bạn viết câu trả lời kết luận (kèm link file tương đối [tên_file](đường_dẫn)) cho mình đọc nha!`;

/**
 * Các lời nhắc kèm theo kết quả tool_result
 */
export const TOOL_RESULT_HINTS = {
   planMode: `Sau khi nhận được kết quả công cụ trên, bạn phân tích kỹ giúp mình nhé. Lưu ý là tụi mình đang ở CHẾ ĐỘ LẬP KẾ HOẠCH (PLAN MODE) nên chưa sửa code (chưa dùng apply_patch/write_file). Nếu cần hỏi ý kiến mình về các phương án thiết kế, hãy gọi request_user_input. Nếu đã đủ thông tin, bạn xuất bản kế hoạch bọc trong thẻ <proposed_plan>...</proposed_plan> bằng tiếng Việt để mình duyệt nhé.`,
   implementPlan: `Sau khi nhận được kết quả công cụ trên, bạn xem kỹ nhé (mã thoát 0 hoặc output trống nghĩa là bước vừa rồi đã thành công). Kế hoạch đã duyệt rồi, bạn tiếp tục bước kế tiếp bằng <custom_tool_call name="apply_patch"> (mỗi lượt 1 file) hoặc exec_command để chạy test nha.`,
   default: `Sau khi nhận được kết quả công cụ trên, bạn xem kỹ nhé (mã thoát 0 hoặc output trống nghĩa là bước vừa rồi đã thành công). Nếu cần làm tiếp bước khác, bạn cứ xuất khối công cụ mới (nhớ dùng apply_patch khi tạo/sửa file hoặc exec_command để chạy lệnh). Nếu đã xong toàn bộ nhiệm vụ, bạn trả lời kết luận cho mình nhé.`,
};

/**
 * Các chỉ dẫn định dạng đầu ra ở cuối lượt yêu cầu của người dùng
 */
export const OUTPUT_FORMAT_HINTS = {
   planMode: `[Yêu cầu đầu ra - Plan Mode]: Đang ở chế độ Plan Mode. Nếu cần mình chốt phương án kỹ thuật, hãy gọi request_user_input. Nếu cần khảo sát thêm, hãy gọi tool đọc (read_file, list_dir). Nếu đã đủ thông tin, bạn xuất bản kế hoạch hoàn chỉnh bọc trong thẻ <proposed_plan>...</proposed_plan> bằng tiếng Việt giúp mình nha.`,
   implementPlan: `[Yêu cầu đầu ra]: Kế hoạch đã duyệt rồi. Bạn xuất ngay khối công cụ tạo hoặc sửa file (dùng apply_patch) tương ứng với bước đầu tiên để triển khai code trực tiếp nhé.`,
   default: `[Yêu cầu đầu ra]: Bạn xuất ngay khối công cụ tương ứng để script trên máy mình thực thi trực tiếp trên dự án thay vì chỉ viết hướng dẫn văn bản nhé.`,
};

/**
 * Lời nhắc chỉ dẫn cho AI khi có hình ảnh đính kèm trong lượt hội thoại
 */
export const M365_IMAGE_ATTACHMENT_HINT = `[HÌNH ẢNH ĐÍNH KÈM]
Tin nhắn này có đính kèm hình ảnh thực tế trong khung chat.
Bạn quan sát trực tiếp hình ảnh đính kèm để phân tích giao diện, mã nguồn, biểu đồ hoặc lỗi giúp mình nhé.`;

/**
 * Lời nhắc định dạng đầu ra chốt hạ súc tích ở cuối prompt.
 */
export function buildShortOutputFormatAnchor(): string {
  return `---
Nhắc nhẹ định dạng để script của mình đọc không bị vấp nhé:
- Bọc toàn bộ phản hồi trong duy nhất 1 khối 4-backtick: \`\`\`\`markdown ... \`\`\`\` (không viết chữ nào bên ngoài khối này).
- Nếu gọi công cụ: Đặt trọn trong <webResponse>...</webResponse>, chỉ chứa các khối <tool_call> hoặc <custom_tool_call name="apply_patch">, không chêm lời dẫn trước/sau thẻ lệnh.
- Nếu trả lời kết luận cho mình: Viết nội dung Markdown (không chứa cú pháp gọi tool) trong khối 4-backtick.`;
}

export const SHORT_OUTPUT_FORMAT_ANCHOR = buildShortOutputFormatAnchor();

export function buildShortOutputFormatPlanAnchor(): string {
  return `---
Nhắc nhẹ định dạng ở chế độ Lập Kế Hoạch (Plan Mode) nhé:
- Bọc toàn bộ phản hồi trong duy nhất 1 khối 4-backtick: \`\`\`\`markdown ... \`\`\`\` (không viết chữ nào bên ngoài khối này).
- Khi xuất bản kế hoạch: Bọc toàn bộ kế hoạch trong đúng một cặp <proposed_plan>...</proposed_plan>.
- Khi khảo sát file: Đặt khối công cụ đọc trong đúng một cặp <webResponse>...</webResponse>. Đừng gọi lệnh sửa file trong Plan Mode nha.`;
}

export const SHORT_OUTPUT_FORMAT_PLAN_ANCHOR = buildShortOutputFormatPlanAnchor();

/**
 * Lời nhắc khi đang tiếp tục các bước kế tiếp của một kế hoạch đã được duyệt (Turn 4+)
 */
export const IMPLEMENT_PLAN_CONTINUATION_PROMPT = `Mình gửi bạn kết quả bước vừa rồi trong thẻ <tool_result> bên dưới nhé.
(Lưu ý nhỏ: Nếu bạn thấy mã thoát bằng 0 "Process exited with code 0" hoặc output trống thì tức là bước vừa rồi đã chạy thành công mỹ mãn rồi đó).

Bước trước đã hoàn tất, bạn kiểm tra kết quả rồi triển khai tiếp bước kế tiếp trong kế hoạch đã duyệt giúp mình nha:
- Nhớ mỗi lượt chỉ tạo hoặc sửa ĐÚNG 1 FILE DUY NHẤT bằng <custom_tool_call name="apply_patch"> (hoặc chạy test/lệnh kiểm tra bằng exec_command).
- Khi tất cả các bước trong kế hoạch đã hoàn thành, bạn viết câu trả lời kết luận tổng kết lại toàn bộ các thay đổi kèm link file tương đối [tên_file](đường_dẫn) cho mình đọc nhé!`;

/**
 * Lời báo khi công cụ hoặc câu lệnh kiểm thử trên máy bị lỗi
 */
export const TOOL_ERROR_FEEDBACK_PROMPT = `Bạn ơi, lệnh hoặc công cụ vừa rồi trên máy mình chạy bị báo lỗi như trong thẻ <tool_result> bên dưới nhé.
Bạn xem lại nguyên nhân lỗi rồi xuất lệnh kiểm tra hoặc xuất khối <custom_tool_call name="apply_patch"> sửa lại giúp mình nha!`;

/**
 * Lời nhắc định dạng nhẹ nhàng cho các lượt đàm thoại / hỏi đáp bình thường hàng ngày
 */
export function buildPureConversationAnchor(): string {
  return `---
Nhắc nhẹ định dạng để script của mình đọc không bị vấp nhé:
- Bọc toàn bộ phản hồi trong duy nhất 1 khối 4-backtick: \`\`\`\`markdown ... \`\`\`\` (không viết chữ nào bên ngoài khối này).
- Nếu chỉ trả lời/thảo luận: Bạn cứ viết nội dung Markdown tự nhiên trong cặp thẻ <webResponse>...</webResponse> cho mình đọc nha.
- Nếu cần xem file hay chạy lệnh trên máy mình: Đặt trọn các thẻ <tool_call> hoặc <custom_tool_call name="apply_patch"> trong <webResponse> mà không chêm lời dẫn.`;
}

export const PURE_CONVERSATION_ANCHOR = buildPureConversationAnchor();

/**
 * Các tùy chọn và hàm tạo yêu cầu format retry khi AI gửi phản hồi lệch quy ước
 */
export interface FormatRetryOptions {
  code: string;
  message: string;
}

export type M365FormatRetryOptions = FormatRetryOptions;

/** Tạo follow-up yêu cầu AI phát lại cùng nội dung theo đúng chuẩn format webResponse, tuyệt đối không tiếp tục tác vụ. */
export function buildFormatRetryPrompt(options: FormatRetryOptions): string {
  return `Bạn ơi, tin nhắn vừa rồi bạn gửi hơi lệch quy ước định dạng một chút nên script cầu nối trên máy mình chưa bóc tách để chạy lệnh được (chưa có công cụ nào được chạy ở lượt vừa rồi cả).
- Điểm bị vấp: [${options.code}] ${options.message}

Bạn giúp mình gửi lại đúng nội dung bạn vừa định làm ở lượt trước vào chuẩn khung này để script mình đọc lại nhé:

\`\`\`\`markdown
<webResponse>
... chỉ đặt các khối <tool_call> / <custom_tool_call name="apply_patch"> hoàn chỉnh (không kèm lời dẫn, không kèm <thought>), HOẶC nội dung câu trả lời Markdown cuối cùng ...
</webResponse>
\`\`\`\``;
}

export const buildM365FormatRetryPrompt = buildFormatRetryPrompt;
