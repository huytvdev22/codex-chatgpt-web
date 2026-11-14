import { describe, expect, test } from "bun:test";
import { CodexRawPayload } from "../src/adapters/web/normalization/codex-raw-payload";
import { CodexPayloadNormalizer } from "../src/adapters/web/normalization/codex-normalizer";
import { compileWebPrompt } from "../src/adapters/web/compile-prompt";
import { WebPromptCompiler } from "../src/adapters/web/prompt";
import { SemanticMarkdownBuffer } from "../src/adapters/web/protocol";
import { parseRequest } from "../src/responses/parser";

const samplePngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2Nk+M/wnwEIGMEEwAIAZAgD/74Q12UAAAAASUVORK5CYII=";
const samplePngDataUrl = `data:image/png;base64,${samplePngBase64}`;

describe("Shared Web Core (Phase 1)", () => {
  test("WebPromptCompiler tham số hóa assistantName và maxPromptChars theo adapter", () => {
    const raw = {
      model: "chatgpt-web/gpt-5",
      input: [
        {
          type: "message",
          role: "user",
          content: "A".repeat(4_000),
        },
      ],
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run shell command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      ],
    };

    const parsed = parseRequest(raw);
    const fullResult = compileWebPrompt(parsed, {
      assistantName: "ChatGPT",
      isNewConversation: true,
    });
    expect(fullResult.finalPrompt).toContain("Chào ChatGPT");
    expect(fullResult.finalPrompt).toContain("nội bộ của ChatGPT");
    expect(fullResult.finalPrompt).not.toContain("M365 Copilot");

    const trimmedResult = compileWebPrompt(parsed, {
      assistantName: "ChatGPT",
      isNewConversation: true,
      maxPromptChars: 1_500,
    });
    expect(trimmedResult.finalPrompt).toContain("Chào ChatGPT");
    expect(trimmedResult.finalPrompt).toContain("tối ưu độ dài cho ChatGPT");
    expect(trimmedResult.finalPrompt.length).toBeLessThanOrEqual(1_500);
    expect(trimmedResult.finalPrompt).not.toContain("M365 Copilot");
  });

  test("CodexPayloadNormalizer tôn trọng giới hạn maxImages cấu hình từ adapter", () => {
    const rawPayload = CodexRawPayload.from({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: samplePngDataUrl },
            { type: "input_image", image_url: samplePngDataUrl },
            { type: "input_image", image_url: samplePngDataUrl },
            { type: "input_image", image_url: samplePngDataUrl },
          ],
        },
      ],
    });

    const normalizedLimited = CodexPayloadNormalizer.normalize(rawPayload, {
      maxImages: 2,
    });
    expect(normalizedLimited.images).toHaveLength(2);

    const normalizedLarger = CodexPayloadNormalizer.normalize(rawPayload, {
      maxImages: 4,
    });
    expect(normalizedLarger.images).toHaveLength(4);
  });

  test("SemanticMarkdownBuffer nhận htmlToMarkdown theo provider, mặc định không dính preset M365", () => {
    const defaultBuffer = new SemanticMarkdownBuffer();
    defaultBuffer.observe([
      {
        key: "b1",
        tag: "p",
        html: "<p>Copilot said: Xin chào</p>",
        text: "Copilot said: Xin chào",
        streamable: true,
      },
    ]);
    // Preset mặc định webHtmlToMarkdown giữ nguyên văn bản nếu không cài leadingPrefixes của M365
    expect(defaultBuffer.finish().markdown).toBe("Copilot said: Xin chào");

    const customBuffer = new SemanticMarkdownBuffer({
      htmlToMarkdown: (html) => html.replace(/<[^>]+>/g, "").replace(/^ChatGPT:\s*/, ""),
    });
    customBuffer.observe([
      {
        key: "b2",
        tag: "p",
        html: "<p>ChatGPT: Xin chào</p>",
        text: "ChatGPT: Xin chào",
        streamable: true,
      },
    ]);
    expect(customBuffer.finish().markdown).toBe("Xin chào");
  });

  test("WebPromptCompiler giữ khả năng nhận normalized trực tiếp không cần parse lại", () => {
    const rawPayload = CodexRawPayload.from({
      model: "chatgpt-web",
      input: [{ type: "message", role: "user", content: "Kiểm tra compiler" }],
    });
    const normalized = CodexPayloadNormalizer.normalize(rawPayload);
    const compiler = new WebPromptCompiler({ assistantName: "ChatGPT" });
    const compiled = compiler.compile({
      normalized,
      isNewConversation: true,
    });

    expect(compiled.finalPrompt).toContain("Chào ChatGPT");
    expect(compiled.finalPrompt).toContain("Kiểm tra compiler");
  });
});
