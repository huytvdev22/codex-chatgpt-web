import { describe, expect, test } from "bun:test";
import path from "node:path";
// @ts-ignore
import { findCircularDependencies } from "../scripts/check-circular-deps.js";

describe("M365 Copilot Architecture Integrity & CI Gate", () => {
  const m365Dir = path.resolve(process.cwd(), "src/adapters/m365-copilot");
  const chatGptDir = path.resolve(process.cwd(), "src/adapters/chatgpt-web");
  const sharedWebDir = path.resolve(process.cwd(), "src/adapters/web");

  test("CI GATE: Tuyệt đối không có Circular Dependency trong m365-copilot (Cycles = 0)", () => {
    const { graph, cycles } = findCircularDependencies(m365Dir);

    if (cycles.length > 0) {
      console.error("\n[CI GATE ERROR] Phát hiện Circular Dependency trong kiến trúc:");
      cycles.forEach((c: any, idx: number) => {
        console.error(`  #${idx + 1}: ${c.join(" -> ")}`);
      });
    }

    expect(cycles.length).toBe(0);
    expect(Object.keys(graph).sort()).toEqual([
      "attachments.ts",
      "capability-picker.ts",
      "conversation-key.ts",
      "conversation-url.ts",
      "index.ts",
      "m365-browser-worker.ts",
    ]);
  });

  test("CI GATE: ChatGPT Web chỉ giữ các module provider và runtime entrypoint bắt buộc", () => {
    const { graph, cycles } = findCircularDependencies(chatGptDir);

    if (cycles.length > 0) {
      console.error("\n[CI GATE ERROR] Phát hiện Circular Dependency trong ChatGPT Web:");
      cycles.forEach((cycle: any, index: number) => {
        console.error(`  #${index + 1}: ${cycle.join(" -> ")}`);
      });
    }

    expect(cycles.length).toBe(0);
    expect(Object.keys(graph).sort()).toEqual([
      "browser-helper-main.ts",
      "chatgpt-browser-worker.ts",
      "conversation-store.ts",
      "index.ts",
      "selectors.ts",
    ]);
  });

  test("CI GATE: Shared Web Adapter layer không có cycle hoặc phụ thuộc ngược vào provider", async () => {
    const { graph, cycles } = findCircularDependencies(sharedWebDir);
    expect(cycles.length).toBe(0);
    expect(Object.keys(graph).length).toBeGreaterThan(10);

    const sharedModules = Object.keys(graph);
    const providerSegments = [
      "/m365-copilot/",
      "/chatgpt-web/",
      "/gemini-web/",
      "/qwen-web/",
    ];
    for (const modulePath of sharedModules) {
      const source = await Bun.file(path.resolve(sharedWebDir, modulePath)).text();
      for (const providerSegment of providerSegments) {
        expect(source.includes(providerSegment)).toBe(false);
      }
      // Không được chứa selector DOM Scriptor đặc thù M365 trong tầng dùng chung
      expect(source.includes("one-copilot-code-identity")).toBe(false);
      expect(source.includes("scriptor-component-code-block")).toBe(false);
    }
  });

  test("CI GATE: Toàn bộ 4 Provider Facade (index.ts) không tự gọi trực tiếp hàm điều phối cấp thấp", async () => {
    const providerFacades = [
      "src/adapters/m365-copilot/index.ts",
      "src/adapters/chatgpt-web/index.ts",
      "src/adapters/gemini-web/index.ts",
      "src/adapters/qwen-web/index.ts",
    ];
    const forbiddenDirectOrchestrationCalls = [
      "startLauncherBrowserTurn(",
      "endLauncherBrowserTurn(",
      "closeLauncherBrowserTurn(",
      "runWebProtocolRetry(",
      "emitWebProtocolResponse(",
      "validateWebProtocolResponse(",
      "parseStrictM365Response(",
      "parseStrictWebResponse(",
    ];

    for (const facadeRelPath of providerFacades) {
      const source = await Bun.file(path.resolve(process.cwd(), facadeRelPath)).text();
      expect(source.includes("extends WebProviderAdapter")).toBe(true);
      for (const forbiddenCall of forbiddenDirectOrchestrationCalls) {
        expect(source.includes(forbiddenCall)).toBe(false);
      }
    }
  });

  test("ARCH INTEGRITY: Root Adapter Facade bảo toàn đầy đủ các API công khai", async () => {
    const rootModule = await import("../src/adapters/m365-copilot");
    const sharedNormalization = await import("../src/adapters/web/normalization");
    const sharedPrompt = await import("../src/adapters/web/prompt");
    const sharedProtocol = await import("../src/adapters/web/protocol");
    const sharedTools = await import("../src/adapters/web/tools");

    // Core Classes
    expect(rootModule.M365AgentLoop).toBeDefined();
    expect(rootModule.M365OutputTranslator).toBeDefined();
    expect(rootModule.M365BrowserWorker).toBeDefined();

    // Normalization
    expect(rootModule.CodexPayloadNormalizer).toBeDefined();
    expect(rootModule.CodexRawPayload).toBeDefined();

    // Native-first Tool Bridge
    expect(rootModule.M365ToolBridge).toBeDefined();
    expect(rootModule.WebToolBridge).toBeDefined();
    expect(rootModule.AtomicFileWriter).toBeDefined();
    expect("PosixCommandStrategy" in rootModule).toBe(false);
    expect("PowerShellCommandStrategy" in rootModule).toBe(false);
    expect("CommandStrategyResolver" in rootModule).toBe(false);

    // Translation Detectors & Helpers
    expect(rootModule.PatchToolCallDetector).toBeDefined();
    expect(rootModule.JsonToolCallDetector).toBeDefined();
    expect(rootModule.XmlToolCallDetector).toBeDefined();
    expect(rootModule.BashCommandDetector).toBeDefined();
    expect(rootModule.BashCommandTranslator).toBeDefined();
    expect(rootModule.stripShellPrefix).toBeDefined();
    expect(rootModule.normalizePatchEnvelope).toBeDefined();

    // Shared Web Adapter facade (both neutral Web* and M365* compatibility aliases)
    expect(sharedNormalization.CodexPayloadNormalizer).toBeDefined();
    expect(sharedNormalization.CodexRawPayload).toBeDefined();
    expect(sharedPrompt.M365PromptCompiler).toBeDefined();
    expect(sharedPrompt.promptCompiler).toBeDefined();
    expect(sharedProtocol.parseStrictWebResponse).toBeDefined();
    expect(sharedProtocol.parseStrictM365Response).toBeDefined();
    expect(sharedProtocol.webHtmlToMarkdown).toBeDefined();
    expect(sharedProtocol.SemanticMarkdownBuffer).toBeDefined();
    expect(sharedTools.WebToolBridge).toBeDefined();
    expect(sharedTools.M365ToolBridge).toBeDefined();
    expect(sharedTools.AtomicFileWriter).toBeDefined();
  });
});
