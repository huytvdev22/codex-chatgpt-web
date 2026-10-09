import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  isTitleRequest,
  generateTitleResponse,
  isTitleGuardEnabled,
} from "../src/adapters/m365-copilot/guards/title-guard";
import type { CodexParsedRequest } from "../src/types";

function createMockParsedRequest(
  messages: Array<{ role: any; content: string }>,
  toolResults?: any[]
): CodexParsedRequest {
  return {
    modelId: "m365-copilot/think",
    stream: true,
    options: {} as any,
    context: {
      messages: messages.map(m => ({ ...m, timestamp: Date.now() })) as any,
      ...(toolResults ? { toolResults } : {}),
    } as any,
  };
}

describe("M365 TitleGuard Regression & Safety Tests", () => {
  const originalEnv = process.env.M365_ENABLE_TITLE_GUARD;

  beforeEach(() => {
    delete process.env.M365_ENABLE_TITLE_GUARD;
    delete process.env.CODEX_M365_ENABLE_TITLE_GUARD;
    delete process.env.ENABLE_TITLE_GUARD;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.M365_ENABLE_TITLE_GUARD = originalEnv;
    } else {
      delete process.env.M365_ENABLE_TITLE_GUARD;
    }
  });

  test("1. MẶC ĐỊNH: Title Guard bị vô hiệu hoá (DISABLED) hoàn toàn để tránh can thiệp nhầm vào Codex", () => {
    expect(isTitleGuardEnabled()).toBe(false);

    const explicitTitleRequest = createMockParsedRequest([
      { role: "user", content: "Generate a short title for the conversation" },
    ]);

    // Khi không có cờ bật, isTitleRequest PHẢI trả về false để request chuyển tiếp trực tiếp lên Copilot
    expect(isTitleRequest(explicitTitleRequest, "Generate a short title for the conversation")).toBe(false);
  });

  test("2. BẬT QUA OPTIONS: Cho phép bật khi truyền flag { enableTitleGuard: true }", () => {
    expect(isTitleGuardEnabled(true)).toBe(true);

    const explicitTitleRequest = createMockParsedRequest([
      { role: "user", content: "Generate a short title for the conversation" },
    ]);

    expect(
      isTitleRequest(explicitTitleRequest, "Generate a short title for the conversation", {
        enableTitleGuard: true,
      })
    ).toBe(true);

    const generated = generateTitleResponse("Generate a short title for the conversation");
    expect(generated).toContain("title: M365 -");
    expect(generated).toContain("description: Phiên lập trình với M365 Copilot");
  });

  test("3. BẬT QUA ENV VAR: Cho phép bật khi đặt M365_ENABLE_TITLE_GUARD='true'", () => {
    process.env.M365_ENABLE_TITLE_GUARD = "true";
    expect(isTitleGuardEnabled()).toBe(true);

    const explicitTitleRequest = createMockParsedRequest([
      { role: "user", content: "Generate a short title for the conversation" },
    ]);

    expect(isTitleRequest(explicitTitleRequest, "Generate a short title for the conversation")).toBe(true);
  });

  test("4. TUYỆT ĐỐI KHÔNG đánh chặn khi turn có kết quả tool_result từ IDE (kể cả khi đã bật guard)", () => {
    const parsedWithToolResults = createMockParsedRequest(
      [{ role: "user", content: "sửa code index.html và app.js" }],
      [
        { role: "toolResult", content: "<!DOCTYPE html>...", toolCallId: "call_1", isError: false },
        { role: "toolResult", content: "console.log('app')...", toolCallId: "call_2", isError: false },
      ]
    );

    const compiledPromptWithTitleAndDescription = `
      [HỆ THỐNG GIAO TIẾP VĂN BẢN VỚI IDE]
      - options: label (string), description (string)
      <title>Tiêu đề</title>
      <tool_result id="call_1">
      <!DOCTYPE html>
      <title>Trang web</title>
      </tool_result>
    `;

    // Kể cả khi bật guard, nếu có tool results thì TUYỆT ĐỐI không đánh chặn
    expect(
      isTitleRequest(parsedWithToolResults, compiledPromptWithTitleAndDescription, {
        enableTitleGuard: true,
      })
    ).toBe(false);
  });

  test("5. TUYỆT ĐỐI KHÔNG đánh chặn yêu cầu code thông thường dù compiledPrompt chứa 'title:' và 'description:'", () => {
    const normalCodingRequest = createMockParsedRequest([
      { role: "user", content: "hãy đọc index.html và tạo file app.js mới" },
    ]);

    const compiledPrompt = `
      AVAILABLE TOOLS:
      - read_file: description: Đọc file
      - request_user_input: description: Phỏng vấn
      VÍ DỤ:
      *** Add File: index.html
      +<title>My App</title>
    `;

    expect(
      isTitleRequest(normalCodingRequest, compiledPrompt, {
        enableTitleGuard: true,
      })
    ).toBe(false);
  });
});
