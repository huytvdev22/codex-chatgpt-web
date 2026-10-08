import { describe, test, expect } from "bun:test";
import { isTitleRequest, generateTitleResponse } from "../src/adapters/m365-copilot/guards/title-guard";
import type { CodexParsedRequest } from "../src/types";

describe("M365 TitleGuard Regression & Safety Tests", () => {
  test("1. TUYỆT ĐỐI KHÔNG đánh chặn khi turn có kết quả tool_result từ IDE", () => {
    const parsedWithToolResults: CodexParsedRequest = {
      model: "m365-copilot/think",
      messages: [
        { role: "user", content: "sửa code index.html và app.js" },
      ],
      context: {
        toolResults: [
          { role: "toolResult", content: "<!DOCTYPE html>...", toolCallId: "call_1", isError: false },
          { role: "toolResult", content: "console.log('app')...", toolCallId: "call_2", isError: false },
        ] as any,
      },
    };

    const compiledPromptWithTitleAndDescription = `
      [HỆ THỐNG GIAO TIẾP VĂN BẢN VỚI IDE]
      - options: label (string), description (string)
      <title>Tiêu đề</title>
      <tool_result id="call_1">
      <!DOCTYPE html>
      <title>Trang web</title>
      </tool_result>
    `;

    // Phải trả về false để request được gửi tiếp lên M365 Copilot, không bị nuốt thành Title
    expect(isTitleRequest(parsedWithToolResults, compiledPromptWithTitleAndDescription)).toBe(false);
  });

  test("2. TUYỆT ĐỐI KHÔNG đánh chặn yêu cầu code thông thường dù compiledPrompt chứa 'title:' và 'description:'", () => {
    const normalCodingRequest: CodexParsedRequest = {
      model: "m365-copilot/think",
      messages: [
        { role: "user", content: "hãy đọc index.html và tạo file app.js mới" },
      ],
    };

    const compiledPrompt = `
      AVAILABLE TOOLS:
      - read_file: description: Đọc file
      - request_user_input: description: Phỏng vấn
      VÍ DỤ:
      *** Add File: index.html
      +<title>My App</title>
    `;

    expect(isTitleRequest(normalCodingRequest, compiledPrompt)).toBe(false);
  });

  test("3. Chỉ nhận diện là Title Request khi tin nhắn thực sự yêu cầu sinh tiêu đề cuộc trò chuyện", () => {
    const explicitTitleRequest: CodexParsedRequest = {
      model: "m365-copilot/think",
      messages: [
        { role: "user", content: "Generate a short title for the conversation" },
      ],
    };

    expect(isTitleRequest(explicitTitleRequest, "Generate a short title for the conversation")).toBe(true);

    const generated = generateTitleResponse("Generate a short title for the conversation");
    expect(generated).toContain("title: M365 -");
    expect(generated).toContain("description: Phiên lập trình với M365 Copilot");
  });
});
