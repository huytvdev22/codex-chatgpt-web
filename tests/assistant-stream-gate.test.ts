import { describe, expect, test } from "bun:test";
import { AssistantStreamGate } from "../src/assistant/assistant-stream-gate";

describe("AssistantStreamGate", () => {
  test("stream văn bản tự nhiên tăng dần và finalize không trùng chữ", () => {
    const deltas: string[] = [];
    const gate = new AssistantStreamGate((delta) => deltas.push(delta));

    gate.pushSnapshot("Chào bạn, ");
    expect(gate.getState()).toBe("STREAMING_TEXT");
    gate.pushSnapshot("Chào bạn, hôm nay trời ");
    gate.pushSnapshot("Chào bạn, hôm nay trời rất đẹp!");

    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(gate.getEmittedText()).toBe("Chào bạn, hôm nay trời rất đẹp!");

    const tail = gate.finalizeAsFinalAnswer("Chào bạn, hôm nay trời rất đẹp!");
    expect(tail).toBe("");
    expect(deltas.join("")).toBe("Chào bạn, hôm nay trời rất đẹp!");
  });

  test("chặn tuyệt đối ngay khi AI bắt đầu mở <tool_call> hoặc <custom_tool_call>", () => {
    const deltas: string[] = [];
    const gate = new AssistantStreamGate((delta) => deltas.push(delta));

    gate.pushSnapshot("<tool_");
    expect(gate.getState()).toBe("BUFFERING");
    expect(deltas).toEqual([]);

    gate.pushSnapshot('<tool_call>\n{"name":"exec_command","arguments":{"cmd":"ls"}}\n</tool_call>');
    expect(gate.getState()).toBe("BLOCKED_TOOL_CALL");
    expect(deltas).toEqual([]);
    expect(gate.hasStreamedText()).toBe(false);

    const patchDeltas: string[] = [];
    const patchGate = new AssistantStreamGate((delta) => patchDeltas.push(delta));
    patchGate.pushSnapshot('<custom_tool_call name="apply_patch">\n*** Begin Patch\n*** End Patch\n</custom_tool_call>');
    expect(patchGate.getState()).toBe("BLOCKED_TOOL_CALL");
    expect(patchDeltas).toEqual([]);
  });

  test("chặn tuyệt đối <tool\\_call> bị Turndown DOM observer escape dấu gạch dưới", () => {
    const deltas: string[] = [];
    const gate = new AssistantStreamGate((delta) => deltas.push(delta));

    gate.pushSnapshot("<tool\\_");
    expect(gate.getState()).toBe("BUFFERING");
    expect(deltas).toEqual([]);

    gate.pushSnapshot('<tool\\_call>{"name":"exec\\_command","arguments":{"cmd":"ls -la"}}</tool\\_call>');
    expect(gate.getState()).toBe("BLOCKED_TOOL_CALL");
    expect(deltas).toEqual([]);
  });

  test("cắt ngay trước <tool\\_call> giữa chừng khi bị Turndown escape", () => {
    const deltas: string[] = [];
    const gate = new AssistantStreamGate((delta) => deltas.push(delta));

    gate.pushSnapshot("Để mình kiểm tra nhé.\n");
    expect(gate.getState()).toBe("STREAMING_TEXT");

    gate.pushSnapshot(
      'Để mình kiểm tra nhé.\n<tool\\_call>{"name":"exec\\_command","arguments":{"cmd":"ls"}}</tool\\_call>',
    );
    expect(gate.getState()).toBe("BLOCKED_TOOL_CALL");
    const streamed = deltas.join("");
    expect(streamed).toContain("Để mình kiểm tra nhé.");
    expect(streamed).not.toContain("tool");
  });

  test("cắt ngay trước <tool_call> xuất hiện giữa chừng và không rò thẻ XML", () => {
    const deltas: string[] = [];
    const gate = new AssistantStreamGate((delta) => deltas.push(delta));

    gate.pushSnapshot("Để mình kiểm tra thư mục cho bạn nhé.\n");
    expect(gate.getState()).toBe("STREAMING_TEXT");

    gate.pushSnapshot(
      'Để mình kiểm tra thư mục cho bạn nhé.\n<tool_call>\n{"name":"exec_command","arguments":{"cmd":"ls"}}\n</tool_call>',
    );
    expect(gate.getState()).toBe("BLOCKED_TOOL_CALL");
    const streamed = deltas.join("");
    expect(streamed).toContain("Để mình kiểm tra thư mục cho bạn nhé.");
    expect(streamed).not.toContain("<tool_call");
    expect(streamed).not.toContain("exec_command");
  });

  test("tail holdback giữ lại nửa thẻ đóng </webResponse> và gỡ wrapper khi finalize", () => {
    const deltas: string[] = [];
    const gate = new AssistantStreamGate((delta) => deltas.push(delta));

    gate.pushSnapshot("````markdown\n<webResponse>\nXin chào thế giới</webRe");
    expect(gate.getState()).toBe("STREAMING_TEXT");
    expect(deltas.join("")).toBe("Xin chào thế giới");

    gate.pushSnapshot("````markdown\n<webResponse>\nXin chào thế giới</webResponse>\n````");
    gate.finalizeAsFinalAnswer("````markdown\n<webResponse>\nXin chào thế giới</webResponse>\n````");
    expect(deltas.join("")).toBe("Xin chào thế giới");
  });

  test("không chặn nhầm ví dụ <tool_call> nằm trong khối code fence", () => {
    const deltas: string[] = [];
    const gate = new AssistantStreamGate((delta) => deltas.push(delta));

    const docText = "Ví dụ cú pháp XML:\n```xml\n<tool_call>\n{}\n</tool_call>\n```\nXong rồi.";
    gate.pushSnapshot(docText);
    expect(gate.getState()).toBe("STREAMING_TEXT");
    gate.finalizeAsFinalAnswer(docText);
    expect(deltas.join("")).toBe(docText);
  });

  test("căn neo đuôi chính xác khi clipboard finalize thêm **bold** giữa câu đã stream", () => {
    const deltas: string[] = [];
    const gate = new AssistantStreamGate((delta) => deltas.push(delta));

    gate.pushSnapshot("Trong `~/CodexAssistant` hiện có 5 thư mục con");
    gate.finalizeAsFinalAnswer("Trong `~/CodexAssistant` hiện có **5 thư mục con**:\n\n- `inbox`");

    const joined = deltas.join("");
    expect(joined).toBe("Trong `~/CodexAssistant` hiện có 5 thư mục con:\n\n- `inbox`");
    expect(joined).not.toContain("conon");
  });

  test("chặn hoàn toàn Action Turn bọc trong 4-backtick + <webResponse> kể cả khi có câu dẫn trước ````markdown", () => {
    const deltas: string[] = [];
    const gate = new AssistantStreamGate((delta) => deltas.push(delta));

    gate.pushSnapshot("Để mình sửa tệp.\n");
    gate.pushSnapshot("Để mình sửa tệp.\n````markdown\n<webR");
    expect(gate.getState()).toBe("BLOCKED_TOOL_CALL");

    gate.pushSnapshot(
      'Để mình sửa tệp.\n````markdown\n<webResponse>\n<custom_tool_call name="apply_patch">\n*** Begin Patch\n*** End Patch\n</custom_tool_call>\n</webResponse>\n````',
    );
    expect(gate.getState()).toBe("BLOCKED_TOOL_CALL");
    expect(deltas.join("")).toBe("Để mình sửa tệp.");
    expect(deltas.join("")).not.toContain("````");
    expect(deltas.join("")).not.toContain("webR");
    expect(deltas.join("")).not.toContain("apply_patch");
  });

  test("chặn kịp ngay từ tiền tố <webResponse xuất hiện sau câu dẫn mà không cần đợi tới <tool_call>", () => {
    const deltas: string[] = [];
    const gate = new AssistantStreamGate((delta) => deltas.push(delta));

    gate.pushSnapshot("Mình sẽ kiểm tra ngay.");
    gate.pushSnapshot("Mình sẽ kiểm tra ngay.\n<webRe");
    expect(deltas.join("")).toBe("Mình sẽ kiểm tra ngay.");

    gate.pushSnapshot('Mình sẽ kiểm tra ngay.\n<webResponse>\n<tool_call>{"name":"exec_command","arguments":{"cmd":"ls"}}</tool_call>\n</webResponse>');
    expect(gate.getState()).toBe("BLOCKED_TOOL_CALL");
    expect(deltas.join("")).toBe("Mình sẽ kiểm tra ngay.");
    expect(deltas.join("")).not.toContain("<web");
  });

  test("finalizeAsFinalAnswer vẫn căn neo chuẩn khi clipboard thêm **bold** ngay từ đầu câu và không lặp đôi khi mismatch", () => {
    const boldStartDeltas: string[] = [];
    const boldStartGate = new AssistantStreamGate((delta) => boldStartDeltas.push(delta));
    boldStartGate.pushSnapshot("Hà Nội hôm nay trời nắng nhẹ");
    boldStartGate.finalizeAsFinalAnswer("**Hà Nội** hôm nay trời nắng nhẹ, khoảng 26°C.");
    expect(boldStartDeltas.join("")).toBe("Hà Nội hôm nay trời nắng nhẹ, khoảng 26°C.");

    const mismatchDeltas: string[] = [];
    const mismatchGate = new AssistantStreamGate((delta) => mismatchDeltas.push(delta));
    mismatchGate.pushSnapshot("Bảng bị vỡ khi đang stream...");
    const appended = mismatchGate.finalizeAsFinalAnswer("| STT | Đường dẫn |\n| --- | --- |\n| 1 | `~/a` |");
    expect(appended).toBe("");
    expect(mismatchDeltas).toEqual(["Bảng bị vỡ khi đang stream..."]);
  });

  test("chặn hoàn toàn khối 3-backtick bọc <webResponse> của Gemini Web nhưng vẫn stream nguyên code block 3-backtick thường", () => {
    // 1. Mở đầu bằng ```markdown\n<webResponse>
    const blockedDeltas: string[] = [];
    const blockedGate = new AssistantStreamGate((delta) => blockedDeltas.push(delta));
    blockedGate.pushSnapshot("```");
    expect(blockedGate.getState()).toBe("BUFFERING");
    blockedGate.pushSnapshot("```markdown\n<webRe");
    expect(blockedGate.getState()).toBe("BUFFERING");
    blockedGate.pushSnapshot(
      '```markdown\n<webResponse>\n<tool_call>{"name":"exec_command","arguments":{"cmd":"ps"}}</tool_call>\n</webResponse>\n```',
    );
    expect(blockedGate.getState()).toBe("BLOCKED_TOOL_CALL");
    expect(blockedDeltas).toEqual([]);

    // 2. Xuất hiện sau câu dẫn ngắn
    const midDeltas: string[] = [];
    const midGate = new AssistantStreamGate((delta) => midDeltas.push(delta));
    midGate.pushSnapshot("Để mình kiểm tra tiến trình.");
    midGate.pushSnapshot("Để mình kiểm tra tiến trình.\n```markdown\n<webR");
    expect(midGate.getState()).toBe("BLOCKED_TOOL_CALL");
    expect(midDeltas.join("")).toBe("Để mình kiểm tra tiến trình.");

    // 3. Code block 3-backtick thông thường ở đầu tin nhắn phải giữ nguyên dấu ```
    const codeDeltas: string[] = [];
    const codeGate = new AssistantStreamGate((delta) => codeDeltas.push(delta));
    const sampleCode = "```markdown\n# Hướng dẫn chi tiết\n- Bước 1: mở app\n```";
    codeGate.pushSnapshot("```markdown\n# Hướng dẫn chi tiết");
    expect(codeGate.getState()).toBe("STREAMING_TEXT");
    codeGate.pushSnapshot(sampleCode);
    codeGate.finalizeAsFinalAnswer(sampleCode);
    expect(codeGate.getState()).toBe("STREAMING_TEXT");
    expect(codeDeltas.join("")).toBe(sampleCode);
  });

  test("chặn hoàn toàn action turn và gỡ wrapper sạch cho final answer dù dòng đóng fence dính nhãn thừa (vd. ```` Grok)", () => {
    const toolDeltas: string[] = [];
    const toolGate = new AssistantStreamGate((delta) => toolDeltas.push(delta));
    toolGate.pushSnapshot("````markdown\n<webResponse>\n<tool_call>");
    toolGate.pushSnapshot(
      '````markdown\n<webResponse>\n<tool_call>{"name":"exec_command","arguments":{"cmd":"ls"}}</tool_call>\n</webResponse>\n```` Grok',
    );
    expect(toolGate.getState()).toBe("BLOCKED_TOOL_CALL");
    expect(toolDeltas).toEqual([]);

    const finalDeltas: string[] = [];
    const finalGate = new AssistantStreamGate((delta) => finalDeltas.push(delta));
    finalGate.pushSnapshot("````markdown\n<webResponse>\nĐã xử lý xong.</webResponse>\n```` Grok");
    finalGate.finalizeAsFinalAnswer("````markdown\n<webResponse>\nĐã xử lý xong.\n</webResponse>\n```` Grok");
    expect(finalDeltas.join("")).toBe("Đã xử lý xong.");
    expect(finalDeltas.join("")).not.toContain("Grok");
  });
});
