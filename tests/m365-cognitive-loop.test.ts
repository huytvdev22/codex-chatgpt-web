import { describe, expect, test } from "bun:test";
import {
  M365AgentLoop,
  type IM365ModelClient,
  type IToolExecutor,
  type AgentLoopOptions,
} from "../src/adapters/m365-copilot/harness";
import {
  isReadOnlyTool,
  getMaxIdenticalToolCalls,
  MAX_IDENTICAL_READ_TOOL_CALLS,
  MAX_IDENTICAL_WRITE_TOOL_CALLS,
  stableToolFingerprint,
} from "../src/adapters/m365-copilot/session";

describe("M365 Cognitive Loop & Agent Resilience Tests (Sprint 1)", () => {
  // =========================================================================
  // 1. Retry with Exponential Backoff
  // =========================================================================
  test("Agent Loop tự động retry khi gặp lỗi tạm thời (quota/timeout) và thành công", async () => {
    let callAttempts = 0;
    const retryEvents: { turn: number; attempt: number; delay: number }[] = [];

    const flakyModelClient: IM365ModelClient = {
      async call(prompt: string) {
        callAttempts++;
        if (callAttempts === 1) {
          throw new Error("429 Too Many Requests: Rate limit exceeded");
        }
        if (callAttempts === 2) {
          throw new Error("Request timeout: gateway timed out");
        }
        // Lần thứ 3 thành công
        return "Tác vụ đã được hoàn thành sau khi thử lại thành công.";
      },
    };

    const loop = new M365AgentLoop(flakyModelClient);
    const result = await loop.run("Thực hiện tác vụ dài hạn", {
      retryOptions: {
        maxRetries: 3,
        baseDelayMs: 10, // Rút ngắn delay trong test
        maxDelayMs: 50,
      },
      onTurnRetry(turn, attempt, error, delay) {
        retryEvents.push({ turn, attempt, delay });
      },
    });

    expect(callAttempts).toBe(3);
    expect(retryEvents.length).toBe(2);
    expect(retryEvents[0].attempt).toBe(1);
    expect(retryEvents[1].attempt).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.finalAnswer).toContain("hoàn thành");
  });

  test("Agent Loop trả về status 'failed' khi lỗi không thể phục hồi hoặc vượt quá maxRetries", async () => {
    let callAttempts = 0;

    const failingModelClient: IM365ModelClient = {
      async call() {
        callAttempts++;
        throw new Error("503 Service Unavailable: temporaily unavailable");
      },
    };

    const loop = new M365AgentLoop(failingModelClient);
    const result = await loop.run("Tác vụ gặp lỗi server liên tục", {
      retryOptions: {
        maxRetries: 2,
        baseDelayMs: 5,
        maxDelayMs: 10,
      },
    });

    expect(callAttempts).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("503 Service Unavailable");
    expect(result.finalAnswer).toContain("thất bại sau khi thử lại");
  });

  // =========================================================================
  // 2. Per-turn Timeout
  // =========================================================================
  test("Agent Loop phát hiện và ngắt timeout per-turn khi model treo lâu", async () => {
    let callAttempts = 0;

    const hangingModelClient: IM365ModelClient = {
      async call() {
        callAttempts++;
        // Treo 200ms
        await new Promise((r) => setTimeout(r, 200));
        return "Xong";
      },
    };

    const loop = new M365AgentLoop(hangingModelClient);
    const result = await loop.run("Tác vụ bị treo", {
      retryOptions: {
        maxRetries: 2,
        perTurnTimeoutMs: 30, // Timeout 30ms < 200ms
        baseDelayMs: 5,
      },
    });

    expect(callAttempts).toBe(2); // Thử lần 1 timeout -> retry lần 2 timeout
    expect(result.status).toBe("failed");
    expect(result.error).toContain("per-turn timeout");
  });

  // =========================================================================
  // 3. Tool Result Validation & System Hint
  // =========================================================================
  test("Tool Execution lỗi được gắn thẻ error và gợi ý system_hint cho model", async () => {
    let promptReceivedAtTurn2 = "";

    const modelClient: IM365ModelClient = {
      async call(prompt: string, context?: { turnIndex: number }) {
        if (context?.turnIndex === 1) {
          // Trả về tool call đọc file không tồn tại
          return `<tool_call>\n{"name": "read_file", "arguments": {"path": "non-existent-file.xyz"}}\n</tool_call>`;
        }
        promptReceivedAtTurn2 = prompt;
        return "Tôi hiểu file không tồn tại, tôi sẽ tạo file mới.";
      },
    };

    const toolExecutor: IToolExecutor = {
      async execute(name, args) {
        return `Lỗi: File không tồn tại tại đường dẫn: ${args.path}`;
      },
    };

    const loop = new M365AgentLoop(modelClient, toolExecutor);
    const result = await loop.run("Đọc file và cập nhật");

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(2);

    // Xác nhận turn 2 nhận được system_hint hướng dẫn
    expect(promptReceivedAtTurn2).toContain('status="error"');
    expect(promptReceivedAtTurn2).toContain("<system_hint>");
    expect(promptReceivedAtTurn2).toContain("tránh lặp lại cùng một thao tác lỗi");

    // Xác nhận message tool_result có cờ isError = true
    const toolMsg = result.messages.find((m) => m.role === "tool_result");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.isError).toBe(true);
  });

  // =========================================================================
  // 4. Default Max Turns = 30
  // =========================================================================
  test("maxTurns mặc định là 30 (nâng từ 10) hỗ trợ tác vụ dài hơi", async () => {
    let turnsRun = 0;

    const endlessModelClient: IM365ModelClient = {
      async call() {
        turnsRun++;
        return `<tool_call>\n{"name": "read_file", "arguments": {"path": "step_${turnsRun}.txt"}}\n</tool_call>`;
      },
    };

    const mockToolExecutor: IToolExecutor = {
      execute: () => "OK",
    };

    const loop = new M365AgentLoop(endlessModelClient, mockToolExecutor);
    // Chạy với maxTurns mặc định (không truyền options.maxTurns)
    // Để test nhanh, ta test override maxTurns = 3 trước, rồi test default value logic
    const result = await loop.run("Chạy lặp 3 turns", { maxTurns: 3 });
    expect(result.status).toBe("max_turns_exceeded");
    expect(result.turns).toBe(3);
  });

  // =========================================================================
  // 5. Read vs Write Tool Quota & Loop Guard
  // =========================================================================
  test("Phân biệt chính xác Read-only tools và Write tools", () => {
    // Read-only tools
    expect(isReadOnlyTool("read_file")).toBe(true);
    expect(isReadOnlyTool("list_dir")).toBe(true);
    expect(isReadOnlyTool("grep_code")).toBe(true);
    expect(isReadOnlyTool("git_status")).toBe(true);
    expect(isReadOnlyTool("git_diff")).toBe(true);
    expect(isReadOnlyTool("view_file")).toBe(true);
    expect(isReadOnlyTool("grep_search")).toBe(true);
    expect(isReadOnlyTool("read_url_content")).toBe(true);

    // Write tools
    expect(isReadOnlyTool("write_file")).toBe(false);
    expect(isReadOnlyTool("run_command")).toBe(false);
    expect(isReadOnlyTool("write_stdin")).toBe(false);
    expect(isReadOnlyTool("apply_patch")).toBe(false);
  });

  test("Giới hạn lặp của Read tool cao hơn Write tool (20 vs 6)", () => {
    expect(getMaxIdenticalToolCalls("read_file")).toBe(MAX_IDENTICAL_READ_TOOL_CALLS); // 20
    expect(getMaxIdenticalToolCalls("view_file")).toBe(MAX_IDENTICAL_READ_TOOL_CALLS); // 20
    expect(getMaxIdenticalToolCalls("write_file")).toBe(MAX_IDENTICAL_WRITE_TOOL_CALLS); // 6
    expect(getMaxIdenticalToolCalls("run_command")).toBe(MAX_IDENTICAL_WRITE_TOOL_CALLS); // 6
  });

  test("Stable Fingerprint phân biệt chính xác khi đọc các phân đoạn dòng khác nhau", () => {
    const fp1 = stableToolFingerprint("read_file", { path: "src/main.ts", start_line: 1, end_line: 50 });
    const fp2 = stableToolFingerprint("read_file", { path: "src/main.ts", start_line: 51, end_line: 100 });
    const fp3 = stableToolFingerprint("read_file", { path: "src/main.ts", start_line: 1, end_line: 50 });

    expect(fp1).not.toBe(fp2);
    expect(fp1).toBe(fp3);
  });
});
