import { describe, expect, test } from "bun:test";
import path from "node:path";
import fs from "node:fs";
// @ts-ignore
import { findCircularDependencies } from "../scripts/check-circular-deps.js";

describe("M365 Copilot Architecture Integrity & CI Gate", () => {
  const m365Dir = path.resolve(process.cwd(), "src/adapters/m365-copilot");
  const baseWebDir = path.resolve(process.cwd(), "src/adapters/base-web");

  test("CI GATE: m365-copilot được tinh gọn còn đúng 4 files và 0 Circular Dependencies", () => {
    const { graph, cycles } = findCircularDependencies(m365Dir);

    if (cycles.length > 0) {
      console.error("\n[CI GATE ERROR] Phát hiện Circular Dependency trong kiến trúc:");
      cycles.forEach((c: any, idx: number) => {
        console.error(`  #${idx + 1}: ${c.join(" -> ")}`);
      });
    }

    expect(cycles.length).toBe(0);
    // Xác thực mục tiêu kiến trúc tinh gọn: m365-copilot chỉ còn 4 files
    const fileCount = Object.keys(graph).length;
    expect(fileCount).toBeLessThanOrEqual(4);
    expect(fileCount).toBeGreaterThanOrEqual(3);
  });

  test("ARCH INTEGRITY: M365 Root Adapter export đầy đủ các thành phần cần thiết", async () => {
    const rootModule = await import("../src/adapters/m365-copilot");

    expect(rootModule.M365CopilotAdapter).toBeDefined();
    expect(rootModule.m365CopilotAdapter).toBeDefined();
    expect(rootModule.createM365CopilotAdapter).toBeDefined();
    expect(rootModule.m365ConversationKey).toBeDefined();
    expect(rootModule.M365BrowserWorker).toBeDefined();
    expect(rootModule.defaultM365BrowserWorker).toBeDefined();
    expect(rootModule.M365CapabilityPicker).toBeDefined();
    expect(rootModule.defaultM365CapabilityPicker).toBeDefined();
  });

  test("ARCH INTEGRITY: Base-Web kế thừa và bảo toàn đầy đủ các API dùng chung", async () => {
    const baseWeb = await import("../src/adapters/base-web");

    // Core Classes
    expect(baseWeb.M365AgentLoop).toBeDefined();
    expect(baseWeb.M365OutputTranslator).toBeDefined();
    expect(baseWeb.BaseOutputTranslator).toBeDefined();

    // Normalization & Guards
    expect(baseWeb.CodexPayloadNormalizer).toBeDefined();
    expect(baseWeb.CodexRawPayload).toBeDefined();
    expect(baseWeb.BaseTitleGuard).toBeDefined();

    // Native-first Tool Bridge
    expect(baseWeb.BaseToolBridge).toBeDefined();
    expect(baseWeb.AtomicFileWriter).toBeDefined();

    // Translation Detectors & Helpers
    expect(baseWeb.PatchToolCallDetector).toBeDefined();
    expect(baseWeb.JsonToolCallDetector).toBeDefined();
    expect(baseWeb.XmlToolCallDetector).toBeDefined();
    expect(baseWeb.BashCommandDetector).toBeDefined();
    expect(baseWeb.BashCommandTranslator).toBeDefined();
    expect(baseWeb.stripShellPrefix).toBeDefined();
    expect(baseWeb.normalizePatchEnvelope).toBeDefined();
  });
});
