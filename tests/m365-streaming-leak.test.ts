import { describe, expect, test } from "bun:test";
import { M365ToolCallDetector } from "../src/adapters/m365-copilot/translation/toolcall-detector";

/**
 * Regression: M365ToolCallDetector không được làm rò rỉ thẻ nội bộ (m365Response, thought, tool_call,
 * custom_tool_call, patch) hay mảnh thẻ dở dang (`</`) ra text_delta, bất kể chunk bị cắt ở vị trí nào.
 */

interface StreamSample {
  name: string;
  raw: string;
  expectedText: string;
  expectedTool: string | null;
}

const SAMPLES: StreamSample[] = [
  {
    name: "final answer có thought + envelope",
    raw: "<m365Response>\n<thought>Phản hồi lời chào của người dùng.</thought>\nXin chào anh Huy! 👋 Hôm nay anh cần làm gì?\n</m365Response>",
    expectedText: "💭 Phản hồi lời chào của người dùng. Xin chào anh Huy! 👋 Hôm nay anh cần làm gì?",
    expectedTool: null,
  },
  {
    name: "custom_tool_call apply_patch có thuộc tính",
    raw: [
      "<m365Response>",
      "<thought>Cần sửa liên kết CSS.</thought>",
      "Mình sẽ sửa hai thẻ liên kết tài nguyên trong `index.html`.",
      "<custom_tool_call name=\"apply_patch\">",
      "*** Begin Patch",
      "*** Update File: index.html",
      "@@",
      "-style.css",
      "+<link rel=\"stylesheet\" href=\"style.css\">",
      "+<script src=\"app.js\"></script>",
      "*** End Patch",
      "</custom_tool_call>",
      "</m365Response>",
    ].join("\n"),
    expectedText: "💭 Cần sửa liên kết CSS. Mình sẽ sửa hai thẻ liên kết tài nguyên trong `index.html`.",
    expectedTool: "apply_patch",
  },
  {
    name: "tool_call JSON exec_command",
    raw: "<m365Response>\n<thought>Đọc file trước.</thought>\nMình sẽ kiểm tra `app.js`.\n<tool_call>\n{\"name\":\"exec_command\",\"arguments\":{\"command\":\"Get-Content -LiteralPath .\\\\app.js\"}}\n</tool_call>\n</m365Response>",
    expectedText: "💭 Đọc file trước. Mình sẽ kiểm tra `app.js`.",
    expectedTool: "exec_command",
  },
  {
    name: "patch trần không có thẻ bọc",
    raw: "<m365Response>\nTạo file mới.\n*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\n</m365Response>",
    expectedText: "Tạo file mới.",
    expectedTool: "apply_patch",
  },
];

const FORBIDDEN_FRAGMENTS = [
  "m365Response",
  "<thought",
  "</thought",
  "tool_call",
  "Begin Patch",
  "End Patch",
  "</",
];

function runStream(chunks: string[]): { text: string; tool: string | null } {
  const detector = new M365ToolCallDetector({ renderThinkingInText: true });
  let text = "";
  for (const chunk of chunks) {
    text += detector.feed(chunk);
  }
  const { remainingText, toolCall } = detector.finish();
  text += remainingText;
  return { text, tool: toolCall?.name ?? null };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function assertClean(sample: StreamSample, chunks: string[], label: string): void {
  const { text, tool } = runStream(chunks);
  for (const fragment of FORBIDDEN_FRAGMENTS) {
    if (text.includes(fragment)) {
      throw new Error(`[${sample.name}] ${label}: rò rỉ "${fragment}" trong text: ${JSON.stringify(text)}`);
    }
  }
  expect(normalize(text)).toBe(sample.expectedText);
  expect(tool).toBe(sample.expectedTool);
}

describe("M365ToolCallDetector streaming leak regression", () => {
  for (const sample of SAMPLES) {
    test(`${sample.name}: một chunk duy nhất`, () => {
      assertClean(sample, [sample.raw], "single chunk");
    });

    test(`${sample.name}: cắt 2 chunk tại mọi vị trí`, () => {
      for (let i = 1; i < sample.raw.length; i++) {
        assertClean(sample, [sample.raw.slice(0, i), sample.raw.slice(i)], `split@${i}`);
      }
    });

    test(`${sample.name}: stream từng ký tự và theo kích thước chunk cố định`, () => {
      for (const size of [1, 2, 3, 5, 7, 13]) {
        const chunks: string[] = [];
        for (let i = 0; i < sample.raw.length; i += size) {
          chunks.push(sample.raw.slice(i, i + size));
        }
        assertClean(sample, chunks, `size=${size}`);
      }
    });
  }

  test("không nuốt khoảng trắng giữa các chunk văn bản thường", () => {
    const { text } = runStream(["<m365Response>\nXin chào anh Huy!", " Hôm nay anh cần gì?\n</m365Response>"]);
    expect(text).toContain("Xin chào anh Huy! Hôm nay anh cần gì?");
  });

  test("không giữ lại vĩnh viễn dấu < trong văn bản thường (so sánh a < b)", () => {
    const { text } = runStream(["Nếu a < b", " thì trả về true."]);
    expect(text).toBe("Nếu a < b thì trả về true.");
  });

  test("thẻ đóng </thought> bị cắt giữa 2 chunk vẫn kết thúc khối suy nghĩ", () => {
    const { text } = runStream(["<thought>Nghĩ</thou", "ght>\nTrả lời."]);
    expect(text).toBe("💭 Nghĩ\n\nTrả lời.");
  });

  test("thẻ đóng </custom_tool_call> bị cắt giữa 2 chunk vẫn phát hiện tool", () => {
    const detector = new M365ToolCallDetector();
    detector.feed("<custom_tool_call name=\"apply_patch\">\n*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n</custom_tool_");
    detector.feed("call>");
    expect(detector.hasDetectedToolCall()).toBe(true);
    expect(detector.getToolCall()?.name).toBe("apply_patch");
  });
});
