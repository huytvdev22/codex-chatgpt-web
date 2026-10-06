import { describe, expect, test } from "bun:test";
import path from "node:path";
// @ts-ignore
import { findCircularDependencies } from "../scripts/check-circular-deps.js";

describe("M365 Copilot Architecture Integrity & CI Gate", () => {
  const m365Dir = path.resolve(process.cwd(), "src/adapters/m365-copilot");

  test("CI GATE: Tuyệt đối không có Circular Dependency trong m365-copilot (Cycles = 0)", () => {
    const { graph, cycles } = findCircularDependencies(m365Dir);

    if (cycles.length > 0) {
      console.error("\n[CI GATE ERROR] Phát hiện Circular Dependency trong kiến trúc:");
      cycles.forEach((c: any, idx: number) => {
        console.error(`  #${idx + 1}: ${c.join(" -> ")}`);
      });
    }

    expect(cycles.length).toBe(0);
    expect(Object.keys(graph).length).toBeGreaterThan(10);
  });

  test("ARCH INTEGRITY: Root Adapter Facade bảo toàn đầy đủ các API công khai", async () => {
    const rootModule = await import("../src/adapters/m365-copilot");

    // Core Classes
    expect(rootModule.M365AgentLoop).toBeDefined();
    expect(rootModule.M365OutputTranslator).toBeDefined();
    expect(rootModule.executeM365Turn).toBeDefined();

    // Normalization & Guards
    expect(rootModule.CodexPayloadNormalizer).toBeDefined();
    expect(rootModule.CodexRawPayload).toBeDefined();
    expect(rootModule.isTitleRequest).toBeDefined();
    expect(rootModule.generateTitleResponse).toBeDefined();

    // Tool Bridge & Strategies
    expect(rootModule.M365ToolBridge).toBeDefined();
    expect(rootModule.AtomicFileWriter).toBeDefined();
    expect(rootModule.PosixCommandStrategy).toBeDefined();
    expect(rootModule.PowerShellCommandStrategy).toBeDefined();
    expect(rootModule.CommandStrategyResolver).toBeDefined();

    // Translation Detectors & Helpers
    expect(rootModule.PatchToolCallDetector).toBeDefined();
    expect(rootModule.JsonToolCallDetector).toBeDefined();
    expect(rootModule.XmlToolCallDetector).toBeDefined();
    expect(rootModule.BashCommandDetector).toBeDefined();
    expect(rootModule.BashCommandTranslator).toBeDefined();
    expect(rootModule.stripShellPrefix).toBeDefined();
    expect(rootModule.normalizePatchEnvelope).toBeDefined();
  });
});
