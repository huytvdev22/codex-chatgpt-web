import { describe, expect, test } from "bun:test";
import {
  BaseOutputTranslator,
  XmlToolCallDetector,
  JsonToolCallDetector,
  PatchToolCallDetector,
  BashCommandDetector,
  CognitiveBlockExtractor,
  SemanticMarkdownBuffer,
  FastPathStreamBuffer,
  stripOuterCodeFence,
} from "../src/adapters/base-web";

describe("BaseWeb Translation Subsystem - Enterprise OOP", () => {
  test("CognitiveBlockExtractor: Bóc tách chính xác thinking và narrative", () => {
    const raw = `<thought>Đây là suy nghĩ nội bộ của bot</thought>
Tôi sẽ giúp bạn sửa lỗi này.
<tool_call>{"name": "read_file", "arguments": {"path": "index.ts"}}</tool_call>`;

    const cognitive = CognitiveBlockExtractor.extract(raw);
    expect(cognitive.thinking).toBe("Đây là suy nghĩ nội bộ của bot");
    expect(cognitive.narrative).toBe("Tôi sẽ giúp bạn sửa lỗi này.");
    expect(cognitive.cleanedText).not.toContain("<thought>");
  });

  test("stripOuterCodeFence: Bóc lớp fence 4-backtick và 3-backtick ngoài cùng", () => {
    const fenced4 = "````markdown\nNội dung văn bản bên trong\n````";
    expect(stripOuterCodeFence(fenced4)).toBe("Nội dung văn bản bên trong");

    const fenced3 = "```json\n{\"test\": 1}\n```";
    expect(stripOuterCodeFence(fenced3)).toBe("{\"test\": 1}");
  });

  test("XmlToolCallDetector: Nhận diện chuẩn xác thẻ XML tool_call", () => {
    const detector = new XmlToolCallDetector();
    const raw = `<tool_call>
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
</tool_call>`;

    const detected = detector.detect(raw);
    expect(detected).not.toBeNull();
    const call = Array.isArray(detected) ? detected[0] : detected;
    expect(call?.name).toBe("read_file");
    expect(call?.arguments.path).toBe("src/index.ts");
  });

  test("JsonToolCallDetector: Nhận diện chuẩn xác JSON object tool call", () => {
    const detector = new JsonToolCallDetector();
    const raw = `\`\`\`json
{"action": "tool_call", "tool": "exec_command", "arguments": {"cmd": "ls -la"}}
\`\`\``;

    const detected = detector.detect(raw);
    expect(detected).not.toBeNull();
    const call = Array.isArray(detected) ? detected[0] : detected;
    expect(call?.name).toBe("exec_command");
    expect(call?.arguments.cmd).toBe("ls -la");
  });

  test("PatchToolCallDetector: Nhận diện chuẩn xác khối Begin/End Patch", () => {
    const detector = new PatchToolCallDetector();
    const raw = `*** Begin Patch
*** Update File: src/main.ts
-old
+new
*** End Patch`;

    const detected = detector.detect(raw);
    expect(detected).not.toBeNull();
    const call = Array.isArray(detected) ? detected[0] : detected;
    expect(call?.name).toBe("apply_patch");
    expect(call?.arguments.input).toContain("*** Begin Patch");
    expect(call?.arguments.input).toContain("*** End Patch");
  });

  test("BaseOutputTranslator: Dịch phản hồi tích hợp Chain of Responsibility", () => {
    const translator = new BaseOutputTranslator([
      new XmlToolCallDetector(),
      new PatchToolCallDetector(),
    ]);

    // 1. Tool Call XML
    const xmlResp = `Tôi sẽ đọc file cho bạn:
<tool_call>{"name": "read_file", "arguments": {"path": "test.txt"}}</tool_call>`;
    const res1 = translator.translate(xmlResp);
    expect(res1.type).toBe("tool_call");
    if (res1.type === "tool_call") {
      expect(res1.tool_calls.length).toBe(1);
      expect(res1.tool_calls[0].function.name).toBe("read_file");
    }

    // 2. Final Answer
    const textResp = "Công việc đã hoàn thành thành công!";
    const res2 = translator.translate(textResp);
    expect(res2.type).toBe("final_answer");
    if (res2.type === "final_answer") {
      expect(res2.content).toBe("Công việc đã hoàn thành thành công!");
    }
  });

  test("SemanticMarkdownBuffer: Quản lý luồng streaming theo Semantic Block", () => {
    const buffer = new SemanticMarkdownBuffer((html) => html.replace(/<[^>]+>/g, "").trim());
    const blocks = [
      { key: "p::1", tag: "p", html: "<p>Dòng 1</p>", text: "Dòng 1", streamable: true },
      { key: "p::2", tag: "p", html: "<p>Dòng 2 đang gõ</p>", text: "Dòng 2 đang gõ", streamable: false },
    ];

    const delta1 = buffer.observe(blocks);
    expect(delta1).toBe("Dòng 1");

    // Khi dòng 2 hoàn tất và xuất hiện dòng 3
    const nextBlocks = [
      { key: "p::1", tag: "p", html: "<p>Dòng 1</p>", text: "Dòng 1", streamable: true },
      { key: "p::2", tag: "p", html: "<p>Dòng 2 đã xong</p>", text: "Dòng 2 đã xong", streamable: true },
      { key: "p::3", tag: "p", html: "<p>Dòng 3</p>", text: "Dòng 3", streamable: false },
    ];

    const delta2 = buffer.observe(nextBlocks);
    expect(delta2).toContain("Dòng 2 đã xong");

    const finalResult = buffer.finish(nextBlocks);
    expect(finalResult.markdown).toContain("Dòng 1");
    expect(finalResult.markdown).toContain("Dòng 2 đã xong");
    expect(finalResult.markdown).toContain("Dòng 3");
  });

  test("FastPathStreamBuffer: Tích lũy delta an toàn", () => {
    const buffer = new FastPathStreamBuffer();
    const delta1 = buffer.observe("Hello ");
    expect(delta1).toBe("Hello ");

    const delta2 = buffer.observe("Hello World");
    expect(delta2).toBe("World");

    const delta3 = buffer.observe("Hello World!");
    expect(delta3).toBe("!");

    const finalRes = buffer.finish();
    expect(finalRes.markdown).toBe("Hello World!");
  });
});
