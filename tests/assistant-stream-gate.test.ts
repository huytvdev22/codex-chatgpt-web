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
});
