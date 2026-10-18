import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dumpRawCodexRequest } from "../src/server";

describe("Tự động lưu Raw Message theo Thread ID và Adapter", () => {
  const testChatGptThread = "test_thread_chatgpt_123";
  const testM365Thread = "test_thread_m365_456";

  afterAll(() => {
    // Dọn dẹp thư mục test history
    const chatGptHistory = join(process.cwd(), "scratch", ".chatgpt", "history", testChatGptThread);
    const m365History = join(process.cwd(), "scratch", ".m365", "history", testM365Thread);
    if (existsSync(chatGptHistory)) rmSync(chatGptHistory, { recursive: true, force: true });
    if (existsSync(m365History)) rmSync(m365History, { recursive: true, force: true });
  });

  test("1. Lưu raw message của ChatGPT Web vào scratch/.chatgpt/history/<threadId>/", () => {
    const payload = {
      model: "chatgpt-web",
      metadata: {
        thread_id: testChatGptThread,
        turn_id: "turn_001",
      },
      input: [
        { role: "user", content: "Viết giúp tôi file README cho dự án" },
      ],
    };

    dumpRawCodexRequest(payload);

    const historyDir = join(process.cwd(), "scratch", ".chatgpt", "history", testChatGptThread);
    expect(existsSync(historyDir)).toBe(true);

    const files = readdirSync(historyDir).filter(f => f.startsWith("turn-") && f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    const content = JSON.parse(readFileSync(join(historyDir, files[0]), "utf-8"));
    expect(content.model).toBe("chatgpt-web");
    expect(content.metadata.thread_id).toBe(testChatGptThread);
    expect(content.input[0].content).toBe("Viết giúp tôi file README cho dự án");

    // File snapshot mới nhất codex-raw.txt cũng tồn tại
    const snapshotPath = join(process.cwd(), "scratch", ".chatgpt", "codex-raw.txt");
    expect(existsSync(snapshotPath)).toBe(true);
  });

  test("2. Lưu raw message của M365 Copilot vào scratch/.m365/history/<threadId>/", () => {
    const payload = {
      model: "m365-copilot/general",
      metadata: {
        thread_id: testM365Thread,
        turn_id: "turn_002",
      },
      input: [
        { role: "user", content: "M365 hỗ trợ tôi kiểm tra cấu trúc thư mục" },
      ],
    };

    dumpRawCodexRequest(payload);

    const historyDir = join(process.cwd(), "scratch", ".m365", "history", testM365Thread);
    expect(existsSync(historyDir)).toBe(true);

    const files = readdirSync(historyDir).filter(f => f.startsWith("turn-") && f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    const content = JSON.parse(readFileSync(join(historyDir, files[0]), "utf-8"));
    expect(content.model).toBe("m365-copilot/general");
    expect(content.metadata.thread_id).toBe(testM365Thread);
    expect(content.input[0].content).toBe("M365 hỗ trợ tôi kiểm tra cấu trúc thư mục");

    // File snapshot mới nhất .m365/codex-raw.txt cũng tồn tại
    const snapshotPath = join(process.cwd(), "scratch", ".m365", "codex-raw.txt");
    expect(existsSync(snapshotPath)).toBe(true);
  });

  test("3. getRawDumpBaseDir trả về thư mục workspace khi dev và thư mục home khi build production", () => {
    const { getRawDumpBaseDir } = require("../src/server");
    const devPath = getRawDumpBaseDir(".chatgpt");
    expect(devPath).toContain("scratch");
    expect(devPath).toContain(".chatgpt");

    // Thử nghiệm khi có biến môi trường chỉ định
    process.env.CODEX_RAW_DUMP_DIR = "/custom/dump/path";
    const customPath = getRawDumpBaseDir(".m365");
    expect(customPath).toBe("/custom/dump/path/.m365");
    delete process.env.CODEX_RAW_DUMP_DIR;
  });
});

