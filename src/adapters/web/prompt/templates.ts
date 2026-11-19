/**
 * Các mẫu chỉ dẫn hệ thống (System Prompts) và lời nhắc thực thi công cụ (Tool Instructions)
 * dành riêng cho Microsoft 365 Copilot Web Adapter.
 *
 * Tách biệt theo nguyên lý Single Responsibility Principle (SOLID):
 * Quản lý độc lập nội dung Prompt Engineering khỏi logic biên dịch ngữ cảnh.
 */

import type { CodexJsonSchemaOutputFormat } from "../../../types";

/**
 * Giao thức giao tiếp thống nhất với IDE.
 * Cho phép truyền tên trợ lý (Copilot, ChatGPT...) với thẻ envelope cố định: webResponse.
 * Đây là bootstrap prompt được gửi ở lượt đầu tiên của mỗi conversation.
 */
export function buildUnifiedToolProtocol(
  assistantName: string = "Copilot"
): string {
  return `Chào ${assistantName}, mình đang làm việc trên dự án ở máy cá nhân và đã nối khung chat này với IDE qua script cầu nối:
- Khi bạn cần đọc/sửa file hoặc chạy lệnh trên máy mình, hãy xuất đúng chuẩn XML bên dưới để script thực thi và trả kết quả trong thẻ \`<tool_result>\` ở lượt tiếp theo.
- Không cần bảo mình copy-paste thủ công, và không dùng công cụ web search hay python nội bộ của ${assistantName}.

Quy ước định dạng phản hồi (bắt buộc):

1. Bọc toàn bộ tin nhắn trong DUY NHẤT 1 khối 4-backtick (\`\`\`\`markdown ... \`\`\`\`):
   - Không viết bất kỳ chữ, lời chào hay thẻ nào nằm ngoài khối \`\`\`\`markdown ngoài cùng.

2. Khi gọi công cụ hoặc sửa file (Action Turn):
   - Đặt các thẻ \`<tool_call>\` hoặc \`<custom_tool_call name="apply_patch">\` thẳng bên trong \`<webResponse>...</webResponse>\`.
   - Không chèn lời dẫn ("Để mình kiểm tra...") hay thẻ \`<thought>\`/\`<thinking>\` ở lượt gọi tool. Có thể gọi nhiều \`<tool_call>\` song song nếu chỉ đọc/kiểm tra.
   - Mẫu function tool:
     \`\`\`\`markdown
     <webResponse>
     <tool_call>
     {"name": "<TOOL_NAME>", "arguments": {"<PARAM_NAME>": "<VALUE>"}}
     </tool_call>
     </webResponse>
     \`\`\`\`

3. Khi tạo mới hoặc chỉnh sửa file (chỉ dùng \`apply_patch\`, tuyệt đối không dùng shell cat/echo/heredoc hay \`write_file\`):
   - Mỗi lượt chỉ tạo hoặc sửa ĐÚNG 1 FILE DUY NHẤT.
   - Gộp các thay đổi gần nhau vào 1 hunk \`@@\` duy nhất; dòng ngữ cảnh (có 1 khoảng trắng đầu dòng) phải khớp chính xác 100% thụt lề file gốc; file mới hoặc file giao diện dễ lệch thẻ (HTML/XML/SVG/JSX/Vue) ưu tiên dùng \`*** Add File:\` kèm dấu \`+\` ở mỗi dòng.
   - Mẫu:
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

4. Khi hoàn tất và trả lời cho mình (Final Answer):
   - Viết câu trả lời Markdown bên trong \`<webResponse>...</webResponse>\` (trong khối 4-backtick), không kèm thẻ tool.
   - Nhắc tới file/dòng code thì gắn link tương đối kiểu [index.html](index.html) hoặc [app.ts — dòng 25](src/app.ts#L25).

Khảo sát mã nguồn: bạn tự do chọn công cụ phù hợp, nhớ bỏ qua thư mục nặng như \`node_modules\`, \`.git\`, \`dist\`, \`build\`. Chỉ dùng các tool có trong \`[MCP TOOL CATALOG]\` bên dưới.`;
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
   - Thoải mái đọc và tìm kiếm file để hiểu cấu trúc, nhưng chỉ sử dụng công cụ đang xuất hiện trong danh sách AVAILABLE TOOLS của lượt hiện tại.
   - PHỎNG VẤN TƯƠNG TÁC (INTERACTIVE USER INTERVIEW WIZARD):
     + Khi bài toán có nhiều lựa chọn kiến trúc, phương án công nghệ hoặc cần làm rõ yêu cầu, bạn cứ gọi công cụ request_user_input để mở wizard cho mình click chọn phương án kèm badge (Recommended) trước khi chốt kế hoạch nhé!
   - KHẢO SÁT & ĐỌC FILE:
     + Bạn tự do quyết định cách đọc file, tra cứu mã nguồn và duyệt cấu trúc thư mục phù hợp với khả năng tư duy của bạn để nắm bắt trọn vẹn dự án. Bạn có thể đọc từng phần hoặc toàn bộ file, chỉ cần lưu ý tránh quét sâu vào các thư mục thư viện nặng như node_modules, .git, dist.
     + Ưu tiên công cụ semantic nếu có trong AVAILABLE TOOLS, hoặc dùng exec_command khi cần thiết.
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
   - Gộp các vị trí sửa gần nhau vào 1 hunk @@ duy nhất, giữ đúng 100% thụt lề gốc và không để rụng ký tự đầu dòng.
   - Tuyệt đối không dùng các lệnh shell (cat <<EOF, cat >, echo >, python, perl, heredoc) để tạo hoặc ghi file trong exec_command.
   - Lệnh exec_command chỉ dùng để chạy lệnh cài đặt hoặc kiểm thử không tương tác (ví dụ: npm install, npm test, tsc --noEmit, git status, mkdir -p ...).
   - Khảo sát mã nguồn: Bạn chủ động lựa chọn công cụ đọc file hoặc lệnh kiểm tra phù hợp theo tư duy kỹ thuật của mình, tránh các thư mục nặng như node_modules.
2. Sau khi file được tạo/sửa xong và nhận kết quả tool_result, bạn tiếp tục các bước kế tiếp hoặc chạy test/lệnh (exec_command, ví dụ npm run typecheck hoặc npx tsc --noEmit) để kiểm tra tính đúng đắn trước khi chốt xong.
3. Không xuất lại thẻ <proposed_plan> nữa vì kế hoạch đã được duyệt.
4. Khi giải thích mã nguồn hoặc nhắc đến tệp tin nào, bạn nhớ dùng Markdown link tương đối: [tên_file](đường_dẫn_tương_đối) (Ví dụ: [index.html](index.html)) hoặc [tên_file — dòng N](đường_dẫn_tương_đối#LN) nha.`;

/**
 * Lời nhắc thực thi công cụ trong quá trình trao đổi để AI tập trung vào kết quả <tool_result>
 */
export const TOOL_REMINDER_PROMPT = `Kết quả thực thi công cụ nằm trong thẻ \`<tool_result>\` bên dưới (mã thoát \`0\` hoặc output trống nghĩa là lệnh vừa chạy thành công).
- Cần bước tiếp: xuất thẳng \`<tool_call>\` hoặc \`<custom_tool_call name="apply_patch">\` (mỗi lượt 1 file) trong \`<webResponse>\`.
- Đã hoàn tất: trả lời Markdown (kèm link [tên_file](đường_dẫn)) trong \`<webResponse>\`.`;

/**
 * Các lời nhắc kèm theo kết quả tool_result
 */
export const TOOL_RESULT_HINTS = {
  planMode: `Sau khi nhận được kết quả công cụ trên, bạn phân tích kỹ giúp mình nhé. Lưu ý là tụi mình đang ở CHẾ ĐỘ LẬP KẾ HOẠCH (PLAN MODE) nên chưa sửa code (chưa dùng apply_patch/write_file). Nếu cần hỏi ý kiến mình về các phương án thiết kế, hãy gọi request_user_input. Nếu đã đủ thông tin, bạn xuất bản kế hoạch bọc trong thẻ <webResponse><proposed_plan>...</proposed_plan></webResponse> bằng tiếng Việt để mình duyệt nhé.`,
  implementPlan: `Sau khi nhận được kết quả công cụ trên, bạn xem kỹ nhé (mã thoát 0 hoặc output trống nghĩa là bước vừa rồi đã thành công). Kế hoạch đã duyệt rồi, bạn tiếp tục bước kế tiếp bằng <custom_tool_call name="apply_patch"> (mỗi lượt 1 file) hoặc exec_command để chạy test nha.`,
  default: `Sau khi nhận được kết quả công cụ trên, bạn xem kỹ nhé (mã thoát 0 hoặc output trống nghĩa là bước vừa rồi đã thành công). Nếu cần làm tiếp bước khác, bạn cứ xuất khối công cụ mới (nhớ dùng apply_patch khi tạo/sửa file hoặc exec_command để chạy lệnh). Nếu đã xong toàn bộ nhiệm vụ, bạn trả lời kết luận cho mình nhé.`,
};

/**
 * Các chỉ dẫn định dạng đầu ra ở cuối lượt yêu cầu của người dùng
 */
export const OUTPUT_FORMAT_HINTS = {
  planMode: `[Yêu cầu đầu ra - Plan Mode]: Đang ở chế độ Plan Mode. Nếu cần mình chốt phương án kỹ thuật, hãy gọi request_user_input khi công cụ này có trong inventory. Nếu cần khảo sát thêm, chỉ sử dụng công cụ đọc hoặc tìm kiếm đang thực sự xuất hiện trong danh sách AVAILABLE TOOLS của lượt hiện tại. Nếu đã đủ thông tin, bạn xuất bản kế hoạch hoàn chỉnh theo đúng response protocol bằng tiếng Việt giúp mình nha.`,
  implementPlan: `[Yêu cầu đầu ra]: Kế hoạch đã duyệt rồi. Bạn xuất ngay khối công cụ tạo hoặc sửa file (dùng apply_patch) tương ứng với bước đầu tiên để triển khai code trực tiếp nhé.`,
  default: `[Yêu cầu đầu ra]: Bạn xuất ngay khối công cụ tương ứng để script trên máy mình thực thi trực tiếp trên dự án thay vì chỉ viết hướng dẫn văn bản nhé.`,
};

/**
 * Lời nhắc chỉ dẫn cho AI khi có hình ảnh đính kèm trong lượt hội thoại
 */
export const WEB_IMAGE_ATTACHMENT_HINT = `[HÌNH ẢNH ĐÍNH KÈM]
Tin nhắn này có đính kèm hình ảnh thực tế trong khung chat.
Bạn quan sát trực tiếp hình ảnh đính kèm để phân tích giao diện, mã nguồn, biểu đồ hoặc lỗi giúp mình nhé.`;

/**
 * Lời nhắc định dạng đầu ra chốt hạ súc tích ở cuối prompt.
 */
export function buildShortOutputFormatAnchor(): string {
  return `---
Format bắt buộc: bọc toàn bộ phản hồi trong 1 khối \`\`\`\`markdown ... \`\`\`\` duy nhất chứa \`<webResponse>...</webResponse>\` (chỉ đặt \`<tool_call>\` / \`<custom_tool_call name="apply_patch">\` nếu gọi tool, hoặc Markdown thuần nếu kết luận).`;
}

export const SHORT_OUTPUT_FORMAT_ANCHOR = buildShortOutputFormatAnchor();

export function buildShortOutputFormatPlanAnchor(): string {
  return `---
Format Plan Mode: bọc toàn bộ trong \`\`\`\`markdown ... \`\`\`\` chứa \`<webResponse>...</webResponse>\` (khảo sát thì đặt \`<tool_call>\`, chốt kế hoạch thì đặt \`<proposed_plan>...</proposed_plan>\`, chưa sửa file).`;
}

export const SHORT_OUTPUT_FORMAT_PLAN_ANCHOR = buildShortOutputFormatPlanAnchor();

/**
 * Lời nhắc khi đang tiếp tục các bước kế tiếp của một kế hoạch đã được duyệt (Turn 4+)
 */
export const IMPLEMENT_PLAN_CONTINUATION_PROMPT = `Kết quả bước vừa rồi nằm trong \`<tool_result>\` (mã thoát \`0\` hoặc output trống = thành công). Bạn tiếp tục bước kế tiếp của kế hoạch (mỗi lượt tối đa 1 file qua \`apply_patch\`, hoặc chạy check bằng \`exec_command\`), xong hết thì tổng kết kèm link [tên_file](đường_dẫn).`;

/**
 * Lời báo khi công cụ hoặc câu lệnh kiểm thử trên máy bị lỗi
 */
export const TOOL_ERROR_FEEDBACK_PROMPT = `Bạn ơi, lệnh hoặc công cụ vừa rồi trên máy mình chạy bị báo lỗi như trong thẻ <tool_result> bên dưới nhé.
Bạn xem lại nguyên nhân lỗi rồi xuất lệnh kiểm tra hoặc xuất khối <custom_tool_call name="apply_patch"> sửa lại giúp mình nha!`;

/**
 * Lời nhắc khi người dùng vừa trả lời wizard khảo sát trong Plan Mode
 */
export const PLAN_USER_INPUT_ANSWER_PROMPT = `[MÌNH ĐÃ CHỌN XONG CÁC PHƯƠNG ÁN - BẮT ĐẦU XUẤT BẢN KẾ HOẠCH]
Cảm ơn bạn đã hỏi ý kiến! Mình vừa hoàn thành chọn các phương án trên wizard giao diện rồi nhé. Dưới đây là các lựa chọn cụ thể của mình:`;

/**
 * Lời nhắc khi người dùng trả lời câu hỏi trong Default Mode
 */
export const USER_INPUT_ANSWER_PROMPT = `[CÂU TRẢ LỜI CỦA MÌNH CHO CÂU HỎI CỦA BẠN]
Mình gửi bạn các câu trả lời / phương án mình đã chọn qua hộp thoại giao diện:`;

/**
 * Lời nhắc khi đang khảo sát mã nguồn trong Plan Mode (nhận kết quả đọc file/chạy lệnh)
 */
export const PLAN_SURVEY_CONTINUATION_PROMPT = `[KẾT QUẢ KHẢO SÁT MÃ NGUỒN - PLAN MODE]
Mình gửi bạn kết quả đọc file / khảo sát lệnh trên máy trong thẻ <tool_result> bên dưới nhé.
Lưu ý là tụi mình vẫn đang ở CHẾ ĐỘ LẬP KẾ HOẠCH (PLAN MODE) nên chưa sửa code (chưa dùng apply_patch/write_file).
- Nếu cần khảo sát tiếp: Bạn chủ động dùng các công cụ phù hợp trong inventory hoặc exec_command để thu thập đầy đủ ngữ cảnh.
- Nếu cần mình chốt phương án thiết kế: Hãy gọi request_user_input để mở wizard cho mình chọn.
- Nếu đã đủ thông tin: Bạn xuất bản kế hoạch hoàn chỉnh bọc trong cặp thẻ <proposed_plan>...</proposed_plan> và Đặt trọn trong <webResponse>...</webResponse> bằng tiếng Việt để mình duyệt nhé!`;

/**
 * Bóc tách và định dạng đẹp câu trả lời của người dùng từ wizard request_user_input
 */
export function formatUserInputAnswers(rawOutput: string): string {
  let data: any;
  try {
    data = typeof rawOutput === "string" ? JSON.parse(rawOutput) : rawOutput;
  } catch {
    return rawOutput.trim();
  }

  if (!data || typeof data !== "object") {
    return String(rawOutput).trim();
  }

  const answersObj = data.answers && typeof data.answers === "object" ? data.answers : data;

  if (Array.isArray(answersObj)) {
    const lines = answersObj.map((item, idx) => {
      if (typeof item !== "object" || item === null) return `- Lựa chọn ${idx + 1}: ${item}`;
      const label = item.header || item.question || item.id || `Câu hỏi ${idx + 1}`;
      const val = item.answer || item.label || item.value || JSON.stringify(item);
      return `- **${label}**: ${val}`;
    });
    return lines.join("\n");
  }

  const entries = Object.entries(answersObj);
  if (entries.length === 0) {
    return String(rawOutput).trim();
  }

  const lines = entries.map(([key, val]) => {
    const displayVal = typeof val === "object" && val !== null ? JSON.stringify(val) : String(val);
    return `- **${key}**: ${displayVal}`;
  });

  return lines.join("\n");
}

/**
 * Lời nhắc định dạng nhẹ nhàng cho các lượt đàm thoại / hỏi đáp bình thường hàng ngày
 */
export function buildPureConversationAnchor(): string {
  return `---
Format bắt buộc: bọc toàn bộ phản hồi trong \`\`\`\`markdown ... \`\`\`\` duy nhất chứa \`<webResponse>...</webResponse>\` (Markdown thuần để trả lời, hoặc \`<tool_call>\` / \`<custom_tool_call name="apply_patch">\` nếu cần thao tác).`;
}

export const PURE_CONVERSATION_ANCHOR = buildPureConversationAnchor();

export interface StructuredJsonPromptOptions {
  assistantName: string;
  schemaName: string;
  strict: boolean;
  schema: unknown;
}

/**
 * Prompt gọn nhẹ dành riêng cho các lượt yêu cầu Structured Output (`json_schema`),
 * bỏ qua hoàn toàn hướng dẫn IDE bridge / tool call cồng kềnh.
 */
export function buildStructuredJsonOutputProtocol(
  options: StructuredJsonPromptOptions,
): string {
  const serializedSchema = JSON.stringify(options.schema, null, 2);
  return `Chào ${options.assistantName}, ở lượt này hệ thống cần kết quả dữ liệu có cấu trúc (Structured Output) để xử lý tự động theo JSON Schema "${options.schemaName}" (strict=${options.strict}):

\`\`\`json
${serializedSchema}
\`\`\`

Quy tắc bắt buộc khi trả lời:
1. Chỉ xuất DUY NHẤT 1 đối tượng JSON hợp lệ khớp chính xác với JSON Schema ở trên (đúng tên trường, đúng kiểu dữ liệu và đầy đủ các trường \`required\`).
2. Ưu tiên đặt toàn bộ JSON bên trong DUY NHẤT 1 khối code \`\`\`json ... \`\`\` (hoặc xuất JSON thuần hợp lệ).
3. TUYỆT ĐỐI KHÔNG xuất dạng YAML, danh sách gạch đầu dòng, lời chào, thẻ XML, hay văn bản giải thích bên ngoài JSON.`;
}

export const STRUCTURED_JSON_OUTPUT_ANCHOR = `[CHỐT ĐỊNH DẠNG ĐẦU RA BẮT BUỘC]:
Chỉ trả về DUY NHẤT 1 JSON hợp lệ khớp chính xác với JSON Schema đã cung cấp (ưu tiên bọc trong khối \`\`\`json ... \`\`\`). Không kèm YAML hay bất kỳ chữ giải thích nào khác.`;

/**
 * Các tùy chọn và hàm tạo yêu cầu format retry khi AI gửi phản hồi lệch quy ước
 */
export interface FormatRetryOptions {
  code: string;
  message: string;
  outputFormat?: CodexJsonSchemaOutputFormat;
}

/**
 * Tạo prompt nhắc AI xuất lại đúng định dạng JSON theo schema khi phản hồi trước sai cấu trúc JSON/Schema.
 */
export function buildJsonSchemaRetryPrompt(options: {
  message: string;
  outputFormat: CodexJsonSchemaOutputFormat;
}): string {
  const serializedSchema = JSON.stringify(options.outputFormat.schema, null, 2);
  return `Phản hồi vừa rồi của bạn chưa đúng định dạng JSON hợp lệ theo JSON Schema "${options.outputFormat.name}" nên hệ thống chưa đọc được:
- Lỗi phát hiện: ${options.message}

Bạn vui lòng chỉ trả về DUY NHẤT 1 khối JSON hợp lệ tuân thủ đúng schema sau (KHÔNG viết YAML, KHÔNG viết lời giải thích, KHÔNG kèm thẻ XML):

\`\`\`json
${serializedSchema}
\`\`\``;
}

/** Tạo follow-up yêu cầu AI phát lại cùng nội dung theo đúng chuẩn format webResponse, tuyệt đối không tiếp tục tác vụ. */
export function buildFormatRetryPrompt(options: FormatRetryOptions): string {
  if (options.code === "INVALID_JSON_SCHEMA_OUTPUT" && options.outputFormat) {
    return buildJsonSchemaRetryPrompt({
      message: options.message,
      outputFormat: options.outputFormat,
    });
  }

  if (options.code === "UNKNOWN_TOOL") {
    return `Bạn ơi, công cụ bạn vừa yêu cầu gọi không tồn tại hoặc không được Codex IDE hỗ trợ ở phiên làm việc này (chưa có công cụ nào được chạy cả):
- Điểm bị vấp: [${options.code}] ${options.message}

Bạn vui lòng chỉ sử dụng công cụ đang xuất hiện trong [MCP TOOL CATALOG] (hoặc gọi \`tools.describe\` / \`tool_search\` nếu cần mở khóa). Không gọi công cụ không tồn tại, rồi gửi lại theo đúng response protocol nhé:

\`\`\`\`markdown
<webResponse>
... chỉ đặt các khối <tool_call> / <custom_tool_call name="apply_patch"> hoàn chỉnh (không kèm lời dẫn, không kèm <thought>), HOẶC nội dung câu trả lời Markdown cuối cùng ...
</webResponse>
\`\`\`\``;
  }

  if (options.code === "DISALLOWED_COMMAND") {
    return `Bạn ơi, câu lệnh shell bạn yêu cầu vừa bị chính sách an toàn của IDE từ chối (chưa có công cụ nào được chạy ở lượt vừa rồi cả):
- Điểm bị vấp: [${options.code}] ${options.message}

Bạn vui lòng không sử dụng vòng lặp duyệt đọc file hàng loạt (foreach... Get-Content) hoặc wildcard (*.ext).
Hãy đổi sang công cụ semantic phù hợp nếu công cụ đó có trong inventory hiện tại, hoặc dùng \`exec_command\` với đường dẫn cụ thể; sau đó gửi lại theo đúng response protocol nhé:

\`\`\`\`markdown
<webResponse>
... chỉ đặt các khối <tool_call> / <custom_tool_call name="apply_patch"> hoàn chỉnh (không kèm lời dẫn, không kèm <thought>), HOẶC nội dung câu trả lời Markdown cuối cùng ...
</webResponse>
\`\`\`\``;
  }

  return `Bạn ơi, tin nhắn vừa rồi bạn gửi hơi lệch quy ước định dạng một chút nên script cầu nối trên máy mình chưa bóc tách để chạy lệnh được (chưa có công cụ nào được chạy ở lượt vừa rồi cả).
- Điểm bị vấp: [${options.code}] ${options.message}

Bạn giúp mình gửi lại đúng nội dung bạn vừa định làm ở lượt trước vào chuẩn khung này để script mình đọc lại nhé:

\`\`\`\`markdown
<webResponse>
... chỉ đặt các khối <tool_call> / <custom_tool_call name="apply_patch"> hoàn chỉnh (không kèm lời dẫn, không kèm <thought>), HOẶC nội dung câu trả lời Markdown cuối cùng ...
</webResponse>
\`\`\`\``;
}
