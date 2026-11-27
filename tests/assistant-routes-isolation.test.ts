import { afterEach, describe, expect, test } from "bun:test";
import type { ManagedTurnRequest, ManagedTurnResult, ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { startServer, type UniversalServer } from "../src/server";

function parseSseEvents(rawSse: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const blocks = rawSse.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (!dataLines.length) continue;
    const rawData = dataLines.join("\n");
    if (rawData === "[DONE]") continue;
    try {
      events.push({ event: eventName, data: JSON.parse(rawData) as Record<string, unknown> });
    } catch {
      // ignore non-json comments
    }
  }
  return events;
}

function createFakeStreamingAdapter(
  onManagedTurnImpl: (req: ManagedTurnRequest) => Promise<ManagedTurnResult>,
): ProviderAdapter {
  return {
    name: "gemini",
    async runTurn() {
      throw new Error("Assistant route không được gọi runTurn mặc định của VS Code Codex");
    },
    async runManagedTurn(request: ManagedTurnRequest): Promise<ManagedTurnResult> {
      return await onManagedTurnImpl(request);
    },
  };
}

describe("Assistant routes isolation & incremental streaming (/clients/assistant/v1/*)", () => {
  let activeServer: UniversalServer | null = null;

  afterEach(async () => {
    if (activeServer) {
      await activeServer.stop(true);
      activeServer = null;
    }
  });

  test("GET /clients/assistant/v1/models & GET /responses (426) hoạt động độc lập", async () => {
    const config = { ...defaultConfig(), host: "127.0.0.1" as const, port: 0 };
    activeServer = startServer(config);
    const baseUrl = `http://127.0.0.1:${activeServer.port}`;

    const modelsRes = await fetch(`${baseUrl}/clients/assistant/v1/models`);
    expect(modelsRes.status).toBe(200);
    const modelsJson = (await modelsRes.json()) as { models?: Array<{ slug?: string }> };
    expect(Array.isArray(modelsJson.models)).toBe(true);
    expect((modelsJson.models ?? []).length).toBeGreaterThan(0);

    const wsUpgradeRes = await fetch(`${baseUrl}/clients/assistant/v1/responses`);
    expect(wsUpgradeRes.status).toBe(426);
  });

  test("POST /clients/assistant/v1/responses stream SSE nhiều delta tăng dần cho văn bản thường", async () => {
    const observedSnapshots: string[] = [];
    const adapter = createFakeStreamingAdapter(async (req) => {
      expect(req.streamIncremental).toBe(true);
      expect(req.conversationKey).toMatch(/^[a-f0-9]{64}$/);
      expect(req.connectorIdentity).toBe("gemini:assistant");
      const chunks = [
        "Xin chào bạn, ",
        "Xin chào bạn, mình đang ",
        "Xin chào bạn, mình đang stream trực tiếp lên Telegram!",
      ];
      for (const snap of chunks) {
        observedSnapshots.push(snap);
        req.onTextSnapshot?.(snap);
        await Bun.sleep(10);
      }
      return {
        rawResponse: chunks[chunks.length - 1],
        conversationId: "conv-stream-1",
        launcherReused: false,
      };
    });

    const config = { ...defaultConfig(), host: "127.0.0.1" as const, port: 0 };
    activeServer = startServer(config, { adapterFactory: () => adapter });
    const baseUrl = `http://127.0.0.1:${activeServer.port}`;

    const res = await fetch(`${baseUrl}/clients/assistant/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "tg-stream-thread-1", turn_id: "turn-1" }),
      },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "Chào bạn" }] }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sseText = await res.text();
    const events = parseSseEvents(sseText);

    const deltaEvents = events.filter((e) => e.data.type === "response.output_text.delta");
    expect(deltaEvents.length).toBeGreaterThanOrEqual(2);
    const combinedText = deltaEvents.map((e) => String(e.data.delta || "")).join("");
    expect(combinedText).toBe("Xin chào bạn, mình đang stream trực tiếp lên Telegram!");
    expect(events.some((e) => e.data.type === "response.completed")).toBe(true);
    expect(observedSnapshots).toHaveLength(3);
  });

  test("POST /clients/assistant/v1/responses chặn hoàn toàn text delta khi AI gọi <tool_call>", async () => {
    const adapter = createFakeStreamingAdapter(async (req) => {
      const snaps = [
        "````markdown\n<webResponse>\n",
        '````markdown\n<webResponse>\n<tool_call>\n{"name":"exec_command",',
        '````markdown\n<webResponse>\n<tool_call>\n{"name":"exec_command","arguments":{"cmd":"ls -la"}}\n</tool_call>\n</webResponse>\n````',
      ];
      for (const snap of snaps) {
        req.onTextSnapshot?.(snap);
        await Bun.sleep(5);
      }
      return {
        rawResponse: snaps[snaps.length - 1],
        conversationId: "conv-tool-1",
        launcherReused: false,
      };
    });

    const config = { ...defaultConfig(), host: "127.0.0.1" as const, port: 0 };
    activeServer = startServer(config, { adapterFactory: () => adapter });
    const baseUrl = `http://127.0.0.1:${activeServer.port}`;

    const res = await fetch(`${baseUrl}/clients/assistant/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "tg-tool-thread-1", turn_id: "turn-1" }),
      },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: true,
        tools: [
          {
            type: "function",
            name: "exec_command",
            parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
          },
        ],
        input: [{ role: "user", content: [{ type: "input_text", text: "Liệt kê file" }] }],
      }),
    });

    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    const deltaEvents = events.filter((e) => e.data.type === "response.output_text.delta");
    expect(deltaEvents).toHaveLength(0);

    const completed = events.find((e) => e.data.type === "response.completed");
    expect(completed).toBeDefined();
    const output = (completed?.data.response as { output?: Array<{ type?: string; name?: string }> })?.output ?? [];
    expect(output.some((item) => item.type === "function_call" && item.name === "exec_command")).toBe(true);
  });

  test("POST /clients/assistant/v1/responses chấp nhận 3-backtick <webResponse> của Gemini Web và không rò XML ra SSE", async () => {
    const adapter = createFakeStreamingAdapter(async (req) => {
      const snaps = [
        "```markdown\n",
        "```markdown\n<webResponse>\n",
        '```markdown\n<webResponse>\n<tool_call>{"name":"exec_command","arguments":{"cmd":"ps -axo pid,comm"}}</tool_call>\n</webResponse>\n\n```',
      ];
      for (const snap of snaps) {
        req.onTextSnapshot?.(snap);
        await Bun.sleep(5);
      }
      return {
        rawResponse: snaps[snaps.length - 1],
        conversationId: "conv-gemini-triple-1",
        launcherReused: false,
      };
    });

    const config = { ...defaultConfig(), host: "127.0.0.1" as const, port: 0 };
    activeServer = startServer(config, { adapterFactory: () => adapter });
    const baseUrl = `http://127.0.0.1:${activeServer.port}`;

    const res = await fetch(`${baseUrl}/clients/assistant/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "tg-gemini-triple-1", turn_id: "turn-1" }),
      },
      body: JSON.stringify({
        model: "gemini/4-neon",
        stream: true,
        tools: [
          {
            type: "function",
            name: "exec_command",
            parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
          },
        ],
        input: [{ role: "user", content: [{ type: "input_text", text: "Xem ứng dụng đang chạy" }] }],
      }),
    });

    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events.filter((e) => e.data.type === "response.output_text.delta")).toHaveLength(0);
    const completed = events.find((e) => e.data.type === "response.completed");
    const output = (completed?.data.response as { output?: Array<{ type?: string; name?: string }> })?.output ?? [];
    expect(output.some((item) => item.type === "function_call" && item.name === "exec_command")).toBe(true);
  });

  test("POST /clients/assistant/v1/responses/compact & /images/generations được gắn route đúng", async () => {
    const adapter = createFakeStreamingAdapter(async () => ({
      rawResponse: "Tóm tắt ngắn gọn ngữ cảnh hội thoại.",
      conversationId: "conv-compact-1",
      launcherReused: false,
    }));
    const config = { ...defaultConfig(), host: "127.0.0.1" as const, port: 0 };
    activeServer = startServer(config, { adapterFactory: () => adapter });
    const baseUrl = `http://127.0.0.1:${activeServer.port}`;

    const compactRes = await fetch(`${baseUrl}/clients/assistant/v1/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        input: [{ role: "user", content: [{ type: "input_text", text: "Tóm tắt lại nhé" }] }],
      }),
    });
    expect(compactRes.status).toBe(200);
    const compactJson = (await compactRes.json()) as { output?: Array<unknown> };
    expect(Array.isArray(compactJson.output)).toBe(true);

    // Gửi thiếu prompt để xác nhận route /images/generations trả 400 validation chứ không phải 404
    const imgRes = await fetch(`${baseUrl}/clients/assistant/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(imgRes.status).toBe(400);
  });

  test("POST /clients/assistant/v1/responses chốt cuối response.output_item.done bằng bản Clipboard sạch, không lặp đôi bảng", async () => {
    const streamedDomTable = "| STT | Đường dẫn |\n| --- | --- |\n| 1 | [~/a](<~/a>) |";
    const cleanClipboardTable = "| STT | Đường dẫn |\n| --- | --- |\n| 1 | `~/a` |";
    const adapter = createFakeStreamingAdapter(async (req) => {
      req.onTextSnapshot?.(streamedDomTable);
      await Bun.sleep(5);
      return {
        rawResponse: cleanClipboardTable,
        conversationId: "conv-table-dedup-1",
        launcherReused: false,
      };
    });

    const config = { ...defaultConfig(), host: "127.0.0.1" as const, port: 0 };
    activeServer = startServer(config, { adapterFactory: () => adapter });
    const baseUrl = `http://127.0.0.1:${activeServer.port}`;

    const res = await fetch(`${baseUrl}/clients/assistant/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "tg-table-dedup", turn_id: "turn-1" }),
      },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "Trả về dạng bảng" }] }],
      }),
    });

    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    const itemDone = events.find((e) => e.data.type === "response.output_item.done");
    const doneText = String(
      ((itemDone?.data.item as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text) ?? "",
    );
    expect(doneText).toBe(cleanClipboardTable);
    expect(doneText.match(/\| STT \| Đường dẫn \|/g)?.length).toBe(1);
  });
});
