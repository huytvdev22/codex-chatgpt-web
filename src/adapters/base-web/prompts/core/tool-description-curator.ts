import type { NormalizedTool } from "../../normalization";

export const MAX_COMPACT_TOOL_DESCRIPTION_CHARS = 320;
export const MAX_FULL_TOOL_DESCRIPTION_CHARS = 1_200;

export class ToolDescriptionCurator {
  /**
   * Rút gọn mô tả công cụ thông minh, loại bỏ các tài liệu dông dài của OpenAI và control tokens rác.
   */
  static cleanToolDescription(name: string, rawDesc?: string): string {
    if (!rawDesc) return "No description provided.";
    let desc = rawDesc.trim();

    // Khử các token placeholder rác dạng ¨C...C
    desc = desc.replace(/¨C[a-zA-Z0-9_-]+C/g, "").replace(/\s{2,}/g, " ").trim();

    // Đối với exec_command: Rút gọn các quy tắc Windows safety rules dông dài lặp lại
    if (name.includes("exec_command") || name.includes("execcommand")) {
      const firstPart = desc.split(/Windows safety rules:/i)[0].trim();
      if (firstPart) {
        desc = firstPart;
      }
    }

    // Đối với web.run hoặc web: Cắt bỏ toàn bộ phần ví dụ, citations, decision boundary, word limits dài dằng dặc
    if (name.includes("web") || desc.includes("## Examples") || desc.includes("---")) {
      desc = desc.split("\n---")[0].split("\n##")[0].trim();
    }

    // Đối với update_goal hoặc create_goal: Chỉ giữ lại 1-2 câu đầu tiên mô tả chức năng
    if (name.includes("goal") && desc.length > 200) {
      const firstSentences = desc.split("\n\n")[0];
      desc = firstSentences || desc.slice(0, 200);
    }

    // Đối với request_user_input hoặc request_user_input_async: Giữ 1-2 câu đầu mô tả chức năng
    if (name.includes("request_user_input") && desc.length > 250) {
      const firstSentences = desc.split("\n\n")[0];
      desc = firstSentences || desc.slice(0, 200);
    }

    return desc.trim();
  }

  /**
   * Viết lại mô tả action cho web chat thay vì forward nguyên văn instruction dài
   * từ Codex. Contract kỹ thuật như wire_name, kind và parameters vẫn giữ nguyên.
   */
  static curateToolDescription(tool: NormalizedTool, compact: boolean): string {
    const wireName = tool.identity.qualifiedName || tool.identity.name;
    const canonicalDescriptions: Record<string, string> = {
      exec_command:
        "Chạy câu lệnh CLI không tương tác trong môi trường và shell đã khai báo. Chỉ dùng khi không có semantic action phù hợp.",
      write_stdin:
        "Gửi thêm dữ liệu vào phiên exec_command đang chạy bằng session_id.",
      list_mcp_resources:
        "Liệt kê resource do MCP server cung cấp. Chỉ dùng khi yêu cầu cần dữ liệu từ MCP resource.",
      list_mcp_resource_templates:
        "Liệt kê resource template do MCP server cung cấp.",
      read_mcp_resource:
        "Đọc một MCP resource bằng server và URI chính xác.",
      request_user_input:
        "Mở hộp thoại hỏi người dùng khi action khả dụng và cần làm rõ thông tin quan trọng.",
      apply_patch:
        "Tạo hoặc sửa file bằng raw patch. Đây là freeform action; không bọc patch trong JSON arguments.",
      view_image:
        "Mở ảnh cục bộ để kiểm tra trực quan.",
      get_goal:
        "Đọc trạng thái goal hiện tại khi workflow goal được sử dụng.",
      create_goal:
        "Tạo goal chỉ khi người dùng hoặc instruction yêu cầu rõ ràng.",
      update_goal:
        "Cập nhật trạng thái goal hiện tại theo đúng lifecycle được hỗ trợ.",
      "web.run":
        "Truy cập web khi yêu cầu cần thông tin trực tuyến, dữ liệu mới hoặc nguồn bên ngoài. Chỉ truyền các tham số đúng schema.",
      "image_gen.imagegen":
        "Tạo hoặc chỉnh sửa hình ảnh khi người dùng yêu cầu nội dung trực quan.",
    };

    const curated = canonicalDescriptions[wireName] || canonicalDescriptions[tool.identity.name];
    if (curated) return curated;

    const raw = (tool.description || "Không có mô tả.")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const cleaned = this.cleanToolDescription(wireName, raw);
    const maxChars = compact ? MAX_COMPACT_TOOL_DESCRIPTION_CHARS : MAX_FULL_TOOL_DESCRIPTION_CHARS;

    return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars).trimEnd()}…` : cleaned;
  }
}
