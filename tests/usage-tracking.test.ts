import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAiStudioTokenCountText } from "../src/adapters/ai-studio/ai-studio-browser-worker";
import { WebPromptSessionStore } from "../src/adapters/web/execution/web-prompt-session-store";
import { CodexPayloadNormalizer, CodexRawPayload } from "../src/adapters/web/normalization";
import {
  UsageFooterFormatter,
  UsageHistoryStore,
  UsageSettingsStore,
  computeAccurateTurnUsage,
} from "../src/usage";

describe("Token Usage Tracking & AI Studio DOM Counter", () => {
  test("parseAiStudioTokenCountText đọc chuẩn số nguyên, dấu phẩy và hậu tố K/M", () => {
    expect(parseAiStudioTokenCountText(" 4,666 tokens ")).toBe(4666);
    expect(parseAiStudioTokenCountText("12,345 / 1,000,000 tokens")).toBe(12345);
    expect(parseAiStudioTokenCountText("12.5K tokens")).toBe(12500);
    expect(parseAiStudioTokenCountText("1.2M tokens")).toBe(1200000);
    expect(parseAiStudioTokenCountText("")).toBeUndefined();
  });

  test("computeAccurateTurnUsage ưu tiên delta DOM AI Studio và fallback sang tiktoken", () => {
    const domResult = computeAccurateTurnUsage({
      prompts: ["Xin chào đây là một câu hỏi bằng tiếng Việt để kiểm tra tokenizer."],
      rawOutputs: ["Chào bạn, tôi đã nhận được."],
      providerReportedTokens: {
        beforeContextTokens: 3000,
        contextTokens: 4666,
        turnDeltaTokens: 1666,
        source: "ai-studio-dom",
      },
    });
    expect(domResult.tokenSource).toBe("ai-studio-dom");
    expect(domResult.contextTokens).toBe(4666);
    expect(domResult.usage.totalTokens).toBe(1666);
    expect(domResult.usage.inputTokens + domResult.usage.outputTokens).toBe(1666);
    expect(domResult.usage.inputTokens).toBeGreaterThan(domResult.usage.outputTokens);

    const tiktokenResult = computeAccurateTurnUsage({
      prompts: ["Hello world from M365 Copilot"],
      rawOutputs: ["PONG"],
    });
    expect(tiktokenResult.tokenSource).toBe("tiktoken");
    expect(tiktokenResult.usage.inputTokens).toBeGreaterThan(0);
    expect(tiktokenResult.usage.outputTokens).toBeGreaterThan(0);
    expect(tiktokenResult.usage.totalTokens).toBe(
      tiktokenResult.usage.inputTokens + tiktokenResult.usage.outputTokens,
    );
  });

  test("UsageFooterFormatter gắn footer và CodexPayloadNormalizer gỡ sạch khỏi priorHistory", () => {
    const formatted = UsageFooterFormatter.appendFooter("Kết quả đã xong.", {
      modelId: "ai-studio/gemini-4-hydrogen",
      stepsCount: 3,
      inputTokens: 1500,
      outputTokens: 320,
      totalTokens: 1820,
      contextTokens: 4666,
      tokenSource: "ai-studio-dom",
      durationMs: 27_400,
    });

    expect(formatted).toContain("📊 `ai-studio/gemini-4-hydrogen`");
    expect(formatted).toContain("task (3 bước): **+1,820** tok");
    expect(formatted).toContain("phiên: **4,666** tok");
    expect(formatted).toContain("27s");
    expect(UsageFooterFormatter.stripFooter(formatted)).toBe("Kết quả đã xong.");

    const normalized = CodexPayloadNormalizer.normalize(
      CodexRawPayload.from({
        model: "ai-studio/gemini-4-hydrogen",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Turn 1" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: formatted }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Turn 2" }],
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: ["user.text"],
            },
          },
        ],
      }),
    );

    const assistantTurn = normalized.priorHistory.find((item) => item.role === "assistant");
    expect(assistantTurn?.content).toBe("Kết quả đã xong.");
  });

  test("WebPromptSessionStore cộng dồn multi-step tool task và không cộng trùng context AI Studio", () => {
    const store = new WebPromptSessionStore();
    const step1Norm = CodexPayloadNormalizer.normalize(
      CodexRawPayload.from({
        model: "ai-studio/gemini-4-hydrogen",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Kiểm tra repo" }],
            internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
          },
        ],
      }),
    );

    const p1 = store.previewTaskUsage("sess-1", step1Norm, {
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
      contextTokens: 3200,
      turnStartedAt: 1_000,
    });
    expect(p1.taskUsage.stepsCount).toBe(1);
    expect(p1.sessionContextTokens).toBe(3200);

    store.commitTurnPrompt("sess-1", step1Norm, [], undefined, undefined, {
      sessionContextTokens: p1.sessionContextTokens,
      activeTaskUsage: p1.taskUsage,
    });

    const step2Norm = CodexPayloadNormalizer.normalize(
      CodexRawPayload.from({
        model: "ai-studio/gemini-4-hydrogen",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Kiểm tra repo" }],
            internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
          },
          {
            type: "function_call",
            call_id: "c1",
            name: "exec_command",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "c1",
            output: "ok",
          },
        ],
      }),
    );

    const p2 = store.previewTaskUsage("sess-1", step2Norm, {
      inputTokens: 1200,
      outputTokens: 266,
      totalTokens: 1466,
      contextTokens: 4666,
      turnStartedAt: 2_000,
    });
    expect(p2.taskUsage.stepsCount).toBe(2);
    expect(p2.taskUsage.totalTokens).toBe(2566);
    expect(p2.sessionContextTokens).toBe(4666);
  });

  test("UsageSettingsStore hot-reload và UsageHistoryStore ghi/đọc JSONL an toàn", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-usage-test-"));
    try {
      const settingsPath = join(dir, "usage-settings.json");
      const historyPath = join(dir, "usage-history.jsonl");
      const settingsStore = new UsageSettingsStore(settingsPath);
      const historyStore = new UsageHistoryStore(historyPath);

      expect(settingsStore.getSnapshot().settings.showChatFooter).toBe(false);
      writeFileSync(settingsPath, JSON.stringify({ version: 1, showChatFooter: true }));
      expect(settingsStore.getSnapshot().settings.showChatFooter).toBe(true);

      historyStore.append({
        id: "t1",
        timestamp: new Date().toISOString(),
        providerId: "ai-studio",
        modelId: "ai-studio/gemini-4-hydrogen",
        status: "completed",
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        contextTokens: 4666,
        tokenSource: "ai-studio-dom",
        durationMs: 4200,
        attempts: 1,
      });

      const records = historyStore.readAll();
      expect(records).toHaveLength(1);
      expect(records[0]?.contextTokens).toBe(4666);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
