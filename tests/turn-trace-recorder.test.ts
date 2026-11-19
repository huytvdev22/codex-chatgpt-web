import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TurnTraceRecorder,
  WebTurnEngine,
  redactLargeTracePayloads,
  type WebProviderDefinition,
} from "../src/adapters/web";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent } from "../src/types";

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-turn-trace-test-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TurnTraceRecorder", () => {
  test("mặc định tắt khi không cấu hình và chỉ bật khi đặt CODEX_WEB_TURN_TRACE", () => {
    const originalEnv = process.env.CODEX_WEB_TURN_TRACE;
    delete process.env.CODEX_WEB_TURN_TRACE;
    try {
      const recorder = new TurnTraceRecorder();
      expect(recorder.isEnabled()).toBe(false);

      process.env.CODEX_WEB_TURN_TRACE = "1";
      expect(recorder.isEnabled()).toBe(true);

      process.env.CODEX_WEB_TURN_TRACE = "true";
      expect(recorder.isEnabled()).toBe(true);

      process.env.CODEX_WEB_TURN_TRACE = "0";
      expect(recorder.isEnabled()).toBe(false);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CODEX_WEB_TURN_TRACE;
      } else {
        process.env.CODEX_WEB_TURN_TRACE = originalEnv;
      }
    }
  });

  test("redactLargeTracePayloads rút gọn chuỗi base64 ảnh quá dài và giữ nguyên cấu trúc", () => {
    const longBase64 = `data:image/png;base64,${"A".repeat(1200)}`;
    const input = {
      model: "m365-copilot/gpt-5.6",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Xem ảnh này giúp tôi" },
            { type: "input_image", image_url: longBase64, detail: "high" },
          ],
        },
      ],
      file_data: "B".repeat(900),
    };

    const redacted = redactLargeTracePayloads(input) as Record<string, any>;
    expect(redacted.input[0].content[0].text).toBe("Xem ảnh này giúp tôi");
    expect(redacted.input[0].content[1].detail).toBe("high");
    expect(redacted.input[0].content[1].image_url).toContain("<omitted");
    expect(redacted.input[0].content[1].image_url.length).toBeLessThan(120);
    expect(redacted.file_data).toContain("file_data omitted");
  });

  test("WebTurnEngine ghi 1 file trace đầy đủ cho mỗi turn (kèm retry attempt, raw request và cooked prompt)", async () => {
    const traceRoot = makeTempDir();
    const recorder = new TurnTraceRecorder({ enabled: true, outputDir: traceRoot });
    let callCount = 0;

    const definition: WebProviderDefinition = {
      id: "test-web",
      assistantName: "Copilot",
      logPrefix: "test-trace",
      policies: {
        manageLauncherLeaseInEngine: false,
        maxFormatRetries: 1,
      },
      conversation: {
        resolveConversationKey: () => "thread_trace_demo",
      },
      browser: {
        launcherProviderId: "m365",
        connectorIdentity: "test-web",
        executeTurn: async () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              rawResponse: "Xin lỗi, mình trả lời sai format không có thẻ webResponse.",
              conversationId: "conv-web-1",
            };
          }
          return {
            rawResponse: "````markdown\n<webResponse>\nĐã nhận đúng yêu cầu.\n</webResponse>\n````",
            conversationId: "conv-web-1",
          };
        },
      },
    };

    const engine = new WebTurnEngine(definition, undefined, undefined, recorder);
    const parsed = parseRequest({
      model: "m365-copilot/gpt-5.6",
      metadata: {
        thread_id: "thread_trace_demo",
        turn_id: "turn_abc_001",
      },
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run terminal command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      ],
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Kiểm tra git status" }],
        },
      ],
    });

    const events: AdapterEvent[] = [];
    await engine.runTurn(
      parsed,
      { headers: new Headers(), abortSignal: new AbortController().signal },
      event => events.push(event),
    );

    const sessionDir = join(traceRoot, "thread_trace_demo");
    const files = readdirSync(sessionDir).sort();
    expect(files.length).toBe(1);
    expect(files[0]).toStartWith("turn-001_");
    expect(files[0]).toContain("FIRST_HANDSHAKE");

    const saved = JSON.parse(readFileSync(join(sessionDir, files[0]), "utf-8"));
    expect(saved.meta.finalStatus).toBe("completed");
    expect(saved.meta.activeConversationId).toBe("conv-web-1");
    expect(saved.normalizedSummary.scenario).toBe("FIRST_HANDSHAKE");
    expect(saved.normalizedSummary.toolsCount).toBe(1);
    expect(saved.rawCodexRequest.model).toBe("m365-copilot/gpt-5.6");
    expect(saved.cookedPromptsByAttempt.length).toBe(2);
    expect(saved.cookedPromptsByAttempt[0].isRetry).toBe(false);
    expect(saved.cookedPromptsByAttempt[0].prompt).toContain("Kiểm tra git status");
    expect(saved.cookedPromptsByAttempt[0].parsedProtocolResult.kind).toBe("protocol_error");
    expect(saved.cookedPromptsByAttempt[1].isRetry).toBe(true);
    expect(saved.cookedPromptsByAttempt[1].parsedProtocolResult.kind).toBe("final_answer");
  });
});
