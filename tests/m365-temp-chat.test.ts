import { describe, expect, it } from "bun:test";
import { stripOuterCodeFence } from "../src/adapters/m365-copilot/temp-chat/stripCodeFence";
import { M365OutputTranslator } from "../src/adapters/m365-copilot/output-translator";
import { compileM365HybridForwardPrompt } from "../src/adapters/m365-copilot/temp-chat/compileHybridForwardPrompt";
import type { CodexParsedRequest } from "../src/types";

describe("Temporary Chat 4-Backtick Fast-Path Specification Tests", () => {
  const translator = new M365OutputTranslator();

  describe("stripOuterCodeFence unit tests", () => {
    it("bóc chính xác lớp vỏ 4-backtick ````markdown và bảo toàn khối ```java bên trong", () => {
      const raw = `\`\`\`\`markdown
1. Giải thích Stream API:
\`\`\`java
List<String> list = Arrays.asList("a", "b");
\`\`\`
Kết luận xong.
\`\`\`\``;

      const stripped = stripOuterCodeFence(raw);
      expect(stripped).toBe(`1. Giải thích Stream API:
\`\`\`java
List<String> list = Arrays.asList("a", "b");
\`\`\`
Kết luận xong.`);
    });

    it("bóc lớp vỏ 4-backtick không có tag ngôn ngữ: ```` ... ````", () => {
      const raw = `\`\`\`\`
Nội dung thuần túy
\`\`\`\``;
      expect(stripOuterCodeFence(raw)).toBe("Nội dung thuần túy");
    });

    it("hỗ trợ bóc lớp vỏ 5-backtick ````\` ... ````\`", () => {
      const raw = `\`\`\`\`\`markdown
Nội dung 5 dấu backticks
\`\`\`\`\``;
      expect(stripOuterCodeFence(raw)).toBe("Nội dung 5 dấu backticks");
    });

    it("vẫn hỗ trợ chuẩn các khối 3-backtick cũ `\`\`\`json ... \`\`\`", () => {
      const raw = `\`\`\`json
{"action": "tool_call", "tool": "read_file", "arguments": {"path": "test.txt"}}
\`\`\``;
      expect(stripOuterCodeFence(raw)).toBe(`{"action": "tool_call", "tool": "read_file", "arguments": {"path": "test.txt"}}`);
    });

    it("giữ nguyên vẹn văn bản không có code fence", () => {
      const raw = "Đây là câu trả lời văn bản thông thường";
      expect(stripOuterCodeFence(raw)).toBe("Đây là câu trả lời văn bản thông thường");
    });
  });

  describe("M365OutputTranslator với phản hồi được bọc 4-backtick", () => {
    it("dịch thành công Tool Call XML khi nằm bên trong khối 4-backtick", () => {
      const rawResponse = `\`\`\`\`markdown
Tôi sẽ đọc nội dung file:
<tool_call>
{"name": "read_file", "arguments": {"path": "src/App.java"}}
</tool_call>
\`\`\`\``;

      const result = translator.translate(rawResponse);
      expect(result.type).toBe("tool_call");
      if (result.type === "tool_call") {
        expect(result.tool_calls.length).toBe(1);
        expect(result.tool_calls[0].function.name).toBe("read_file");
        const args = JSON.parse(result.tool_calls[0].function.arguments);
        expect(args.path).toBe("src/App.java");
      }
    });

    it("dịch thành công Codex Patch khi nằm bên trong khối 4-backtick", () => {
      const rawResponse = `\`\`\`\`markdown
Tôi sẽ cập nhật file:
*** Begin Patch
*** Update File: src/App.java
@@ main @@
- old
+ new
*** End Patch
\`\`\`\``;

      const result = translator.translate(rawResponse);
      expect(result.type).toBe("tool_call");
      if (result.type === "tool_call") {
        expect(result.tool_calls[0].function.name).toBe("apply_patch");
        const args = JSON.parse(result.tool_calls[0].function.arguments);
        expect(args.input).toContain("*** Begin Patch");
        expect(args.input).toContain("*** End Patch");
      }
    });

    it("trả về Final Answer sạch (đã lột 4-backtick ngoài cùng) cho người dùng Codex IDE", () => {
      const rawResponse = `\`\`\`\`markdown
1. **Giải thích ngắn về Stream API**
Stream API giúp xử lý danh sách tuần tự hoặc song song.

2. **Mã mẫu:**
\`\`\`java
public class App {
  public static void main(String[] args) {}
}
\`\`\`
\`\`\`\``;

      const result = translator.translate(rawResponse);
      expect(result.type).toBe("final_answer");
      if (result.type === "final_answer") {
        expect(result.content.startsWith("1. **Giải thích ngắn")).toBe(true);
        expect(result.content.includes("```java")).toBe(true);
        expect(result.content.startsWith("````")).toBe(false);
        expect(result.content.endsWith("````")).toBe(false);
      }
    });
  });

  describe("compileM365HybridForwardPrompt", () => {
    it("luôn đính kèm chỉ thị 4-backtick ở cuối cùng của prompt", () => {
      const dummyRequest: CodexParsedRequest = {
        modelId: "gpt-4o",
        context: {
          messages: [
            { role: "user", content: "Viết giúp tôi một đoạn code Java" }
          ],
        },
      };

      const prompt = compileM365HybridForwardPrompt(dummyRequest);
      expect(prompt).toContain("[QUY TẮC ĐỊNH DẠNG ĐẦU RA BẮT BUỘC]");
      expect(prompt).toContain("4 dấu backtick");
      expect(prompt.endsWith("TUYỆT ĐỐI KHÔNG VIẾT BẤT KỲ KÝ TỰ HAY VĂN BẢN NÀO BÊN NGOÀI KHỐI CODE NÀY.")).toBe(true);
    });
  });
});
