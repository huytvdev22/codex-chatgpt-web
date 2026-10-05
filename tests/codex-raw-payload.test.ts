import { describe, expect, test } from "bun:test";
import {
  CodexRawPayload,
  CodexWireParser,
  type CodexRawRequestWire,
} from "../src/adapters/m365-copilot/codex-raw-payload";

describe("CodexRawPayload & CodexWireParser Tests (Giai đoạn 1)", () => {
  const sampleWireRequest: CodexRawRequestWire = {
    model: "m365-copilot/think",
    stream: true,
    store: false,
    tool_choice: "auto",
    parallel_tool_calls: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "thread_abc_123",
    text: { verbosity: "low" },
    client_metadata: {
      thread_id: "thread_abc_123",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_abc_123",
        turn_id: "turn_xyz_789",
        request_kind: "turn",
      }),
    },
    tools: [
      {
        type: "function",
        name: "custom_root_tool",
        description: "Root tool description",
      },
    ],
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Thêm comment cho file ci.yml" }],
      },
    ],
  };

  test("CodexWireParser: Structural Guards từ chối request không hợp lệ", () => {
    expect(() => CodexWireParser.parse(null)).toThrow(TypeError);
    expect(() => CodexWireParser.parse(undefined)).toThrow(TypeError);
    expect(() => CodexWireParser.parse("string")).toThrow(TypeError);
    expect(() => CodexWireParser.parse(123)).toThrow(TypeError);
    expect(() => CodexWireParser.parse([])).toThrow(TypeError);

    // model sai kiểu
    expect(() => CodexWireParser.parse({ model: 123 as any })).toThrow(TypeError);
    // input sai kiểu
    expect(() => CodexWireParser.parse({ model: "test", input: "not-array" as any })).toThrow(TypeError);
    // tools sai kiểu
    expect(() => CodexWireParser.parse({ model: "test", tools: "not-array" as any })).toThrow(TypeError);
    // client_metadata sai kiểu
    expect(() => CodexWireParser.parse({ model: "test", client_metadata: "not-object" as any })).toThrow(TypeError);

    // Request hợp lệ
    const valid = CodexWireParser.parse({ model: "m365-copilot/think", input: [] });
    expect(valid.model).toBe("m365-copilot/think");
  });

  test("Deep Snapshot Fidelity: toJSON() bảo toàn 1:1 parsed JSON snapshot và bất biến", () => {
    const inputClone = structuredClone(sampleWireRequest);
    const payload = CodexRawPayload.from(inputClone);

    expect(payload.model).toBe("m365-copilot/think");
    expect(payload.stream).toBe(true);
    expect(payload.store).toBe(false);
    expect(payload.tool_choice).toBe("auto");
    expect(payload.parallel_tool_calls).toBe(false);
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
    expect(payload.text).toEqual({ verbosity: "low" });
    expect(payload.getThreadId()).toBe("thread_abc_123");
    expect(payload.getTurnId()).toBe("turn_xyz_789");

    // Sửa đổi object gốc bên ngoài không làm ảnh hưởng snapshot bên trong
    (inputClone as any).model = "modified-model";
    expect(payload.model).toBe("m365-copilot/think");

    // toJSON trả về bản sao deep clone mới
    const exported1 = payload.toJSON();
    const exported2 = payload.toJSON();
    expect(exported1).toEqual(sampleWireRequest);
    expect(exported1).not.toBe(exported2);
  });

  test("Bảo toàn các trường không có trong schema chuẩn vào extra", () => {
    const rawWithExtra: CodexRawRequestWire = {
      model: "test-model",
      some_custom_future_flag: "active",
      custom_config: { nested: true },
    };

    const payload = CodexRawPayload.from(rawWithExtra);
    expect(payload.extra["some_custom_future_flag"]).toBe("active");
    expect(payload.extra["custom_config"]).toEqual({ nested: true });
  });

  test("Không tự ý gán default làm sai lệch raw wire", () => {
    // Không có stream trong request gốc
    const payload = CodexRawPayload.from({ model: "custom-model" });
    expect(payload.stream).toBeUndefined();
    expect(payload.store).toBeUndefined();
    expect(payload.parallel_tool_calls).toBeUndefined();
    expect(payload.tools).toBeUndefined();
  });
});
