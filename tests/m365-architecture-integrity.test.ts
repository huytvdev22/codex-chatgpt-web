import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
// @ts-ignore
import { findCircularDependencies } from "../scripts/check-circular-deps.js";

function discoverProviderAdapterNames(): string[] {
  const adaptersRoot = path.resolve(process.cwd(), "src/adapters");
  return fs
    .readdirSync(adaptersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "web")
    .map((entry) => entry.name)
    .sort();
}

describe("Web Adapter Architecture Integrity & CI Gate", () => {
  const sharedWebDir = path.resolve(process.cwd(), "src/adapters/web");
  const providerNames = discoverProviderAdapterNames();

  test("CI GATE: Tuyệt đối không có Circular Dependency trong mọi provider adapter (Cycles = 0)", () => {
    expect(providerNames.length).toBeGreaterThanOrEqual(1);
    expect(providerNames).toContain("m365-copilot");

    for (const providerName of providerNames) {
      const providerDir = path.resolve(process.cwd(), "src/adapters", providerName);
      const { graph, cycles } = findCircularDependencies(providerDir);

      if (cycles.length > 0) {
        console.error(`\n[CI GATE ERROR] Phát hiện Circular Dependency trong ${providerName}:`);
        cycles.forEach((c: any, idx: number) => {
          console.error(`  #${idx + 1}: ${c.join(" -> ")}`);
        });
      }

      expect(cycles.length).toBe(0);
      expect(Object.keys(graph)).toContain("index.ts");

      if (providerName === "m365-copilot") {
        expect(Object.keys(graph).sort()).toEqual([
          "attachments.ts",
          "capability-picker.ts",
          "conversation-key.ts",
          "conversation-url.ts",
          "index.ts",
          "m365-browser-worker.ts",
          "m365-clipboard-salvage.ts",
          "m365-dom-observer.ts",
          "model-discovery.ts",
          "model-provider.ts",
        ]);
      }
    }
  });

  test("CI GATE: Shared Web Adapter layer không có cycle hoặc phụ thuộc ngược vào provider", async () => {
    const { graph, cycles } = findCircularDependencies(sharedWebDir);
    expect(cycles.length).toBe(0);
    expect(Object.keys(graph).length).toBeGreaterThan(10);

    const sharedModules = Object.keys(graph);
    const providerSegments = providerNames.map((name) => `/${name}/`);
    for (const modulePath of sharedModules) {
      const source = await Bun.file(path.resolve(sharedWebDir, modulePath)).text();
      for (const providerSegment of providerSegments) {
        expect(source.includes(providerSegment)).toBe(false);
      }
      // Không được chứa selector DOM Scriptor đặc thù M365 trong tầng dùng chung
      expect(source.includes("one-copilot-code-identity")).toBe(false);
      expect(source.includes("scriptor-component-code-block")).toBe(false);
    }

    // Shared compiler & semantic detector phải trung tính provider
    const compilerSource = await Bun.file(path.resolve(sharedWebDir, "prompt/compiler.ts")).text();
    expect(compilerSource.includes("Microsoft 365 Copilot")).toBe(false);

    const semanticDetectorSource = await Bun.file(
      path.resolve(sharedWebDir, "protocol/semantic-detector.ts"),
    ).text();
    expect(semanticDetectorSource.includes("m365HtmlToMarkdown(")).toBe(false);

    const outputTranslatorSource = await Bun.file(
      path.resolve(sharedWebDir, "protocol/output-translator.ts"),
    ).text();
    expect(outputTranslatorSource.includes("[M365 RAW RESPONSE]")).toBe(false);

    // Service layer không phụ thuộc trực tiếp vào web adapter internals cho turn identity
    const responsesServiceSource = await Bun.file(
      path.resolve(process.cwd(), "src/services/responses-service.ts"),
    ).text();
    expect(responsesServiceSource.includes("adapters/web/turn-identity")).toBe(false);

    // Legacy dead code modules must remain absent
    expect(await Bun.file(path.resolve(sharedWebDir, "prompt/assembler.ts")).exists()).toBe(false);
    expect(await Bun.file(path.resolve(sharedWebDir, "harness/index.ts")).exists()).toBe(false);
    expect(await Bun.file(path.resolve(sharedWebDir, "conversation/conversation-store.ts")).exists()).toBe(false);
  });

  test("CI GATE: Provider Facade (index.ts) không tự gọi trực tiếp hàm điều phối cấp thấp", async () => {
    const providerFacades = providerNames.map((name) => `src/adapters/${name}/index.ts`);
    const forbiddenDirectOrchestrationCalls = [
      "startLauncherBrowserTurn(",
      "endLauncherBrowserTurn(",
      "closeLauncherBrowserTurn(",
      "runWebProtocolRetry(",
      "emitWebProtocolResponse(",
      "validateWebProtocolResponse(",
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

  test("ARCH INTEGRITY: Root Adapter Facade & Shared Web Layer dùng API chuẩn trung tính", async () => {
    const rootModule = await import("../src/adapters/m365-copilot");
    const sharedNormalization = await import("../src/adapters/web/normalization");
    const sharedPrompt = await import("../src/adapters/web/prompt");
    const sharedProtocol = await import("../src/adapters/web/protocol");
    const sharedTools = await import("../src/adapters/web/tools");

    // Core Classes
    expect(rootModule.WebOutputTranslator).toBeDefined();
    expect(rootModule.M365BrowserWorker).toBeDefined();
    expect(rootModule.M365ModelProvider).toBeDefined();
    expect(rootModule.m365HtmlToMarkdown).toBeDefined();

    // Normalization
    expect(rootModule.CodexPayloadNormalizer).toBeDefined();
    expect(rootModule.CodexRawPayload).toBeDefined();

    // Native-first Tool Bridge
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

    // Shared Web Adapter facade (pure neutral Web* APIs)
    expect(sharedNormalization.CodexPayloadNormalizer).toBeDefined();
    expect(sharedNormalization.CodexRawPayload).toBeDefined();
    expect(sharedPrompt.WebPromptCompiler).toBeDefined();
    expect(sharedPrompt.promptCompiler).toBeDefined();
    expect(sharedPrompt.WEB_IMAGE_ATTACHMENT_HINT).toBeDefined();
    expect(sharedPrompt.buildFormatRetryPrompt).toBeDefined();
    expect(sharedProtocol.WebOutputTranslator).toBeDefined();
    expect(sharedProtocol.WebToolCallDetector).toBeDefined();
    expect(sharedProtocol.parseStrictWebResponse).toBeDefined();
    expect(sharedProtocol.WEB_RESPONSE_OPEN_TAG).toBeDefined();
    expect(sharedProtocol.WEB_RESPONSE_CLOSE_TAG).toBeDefined();
    expect(sharedProtocol.webHtmlToMarkdown).toBeDefined();
    expect(sharedProtocol.SemanticMarkdownBuffer).toBeDefined();
    expect(sharedTools.WebToolBridge).toBeDefined();
    expect(sharedTools.normalizeWebToolArguments).toBeDefined();
    expect(sharedTools.decodeWebContent).toBeDefined();
    expect(sharedTools.validateWebToolCall).toBeDefined();
    expect(sharedTools.AtomicFileWriter).toBeDefined();

    // Legacy M365* compatibility aliases in shared web layer must remain absent
    expect("M365_MAX_INPUT_IMAGES" in sharedNormalization).toBe(false);
    expect("M365PromptCompiler" in sharedPrompt).toBe(false);
    expect("M365_IMAGE_ATTACHMENT_HINT" in sharedPrompt).toBe(false);
    expect("buildM365FormatRetryPrompt" in sharedPrompt).toBe(false);
    expect("M365OutputTranslator" in sharedProtocol).toBe(false);
    expect("M365ToolCallDetector" in sharedProtocol).toBe(false);
    expect("parseStrictM365Response" in sharedProtocol).toBe(false);
    expect("M365_RESPONSE_OPEN_TAG" in sharedProtocol).toBe(false);
    expect("M365_RESPONSE_CLOSE_TAG" in sharedProtocol).toBe(false);
    expect("m365HtmlToMarkdown" in sharedProtocol).toBe(false);
    expect("M365MarkdownBuffer" in sharedProtocol).toBe(false);
    expect("M365ToolBridge" in sharedTools).toBe(false);
    expect("normalizeM365ToolName" in sharedTools).toBe(false);
    expect("normalizeM365ToolArguments" in sharedTools).toBe(false);
    expect("decodeM365Content" in sharedTools).toBe(false);
    expect("validateM365ToolCall" in sharedTools).toBe(false);
  });
});
