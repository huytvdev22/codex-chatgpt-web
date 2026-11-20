const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createUsageStore,
  summarizeUsageRecords,
} = require("../electron/infra/usage-store.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const ipcRouterSource = fs.readFileSync(path.join(launcherRoot, "electron", "app", "ipc-router.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");

test("usage-store gom nhóm chuẩn theo provider, model và khoảng thời gian", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-usage-"));
  try {
    const settingsPath = path.join(dir, "usage-settings.json");
    const historyPath = path.join(dir, "usage-history.jsonl");
    const now = new Date("2026-11-20T05:00:00.000Z");

    const lines = [
      JSON.stringify({
        id: "1",
        timestamp: "2026-11-20T04:00:00.000Z",
        providerId: "ai-studio",
        modelId: "ai-studio/gemini-4-hydrogen",
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        contextTokens: 4666,
        tokenSource: "ai-studio-dom",
        durationMs: 3000,
      }),
      JSON.stringify({
        id: "2",
        timestamp: "2026-11-20T04:30:00.000Z",
        providerId: "m365-copilot",
        modelId: "m365-copilot/gpt-5.6",
        inputTokens: 800,
        outputTokens: 100,
        totalTokens: 900,
        contextTokens: 900,
        tokenSource: "tiktoken",
        durationMs: 5000,
      }),
      JSON.stringify({
        id: "3",
        timestamp: "2026-11-01T04:00:00.000Z",
        providerId: "m365-copilot",
        modelId: "m365-copilot",
        inputTokens: 5000,
        outputTokens: 500,
        totalTokens: 5500,
        tokenSource: "tiktoken",
        durationMs: 7000,
      }),
    ];
    fs.writeFileSync(historyPath, `${lines.join("\n")}\n`);

    const allSummary = summarizeUsageRecords(
      lines.map((l) => JSON.parse(l)),
      "all",
      now,
    );
    assert.equal(allSummary.totals.turns, 3);
    assert.equal(allSummary.totals.totalTokens, 7600);
    assert.equal(allSummary.byProvider.length, 2);
    assert.equal(allSummary.byProvider[0].key, "m365-copilot");
    assert.equal(allSummary.byProvider[0].totalTokens, 6400);
    assert.equal(allSummary.byModel.length, 3);

    const last7d = summarizeUsageRecords(
      lines.map((l) => JSON.parse(l)),
      "7d",
      now,
    );
    assert.equal(last7d.totals.turns, 2);
    assert.equal(last7d.totals.totalTokens, 2100);

    const store = createUsageStore(settingsPath, historyPath);
    const initial = store.read("all");
    assert.equal(initial.settings.showChatFooter, false);
    assert.equal(initial.summary.totals.turns, 3);

    const saved = store.saveSettings({ showChatFooter: true }, "all");
    assert.equal(saved.settings.showChatFooter, true);

    const cleared = store.clearHistory("all");
    assert.equal(cleared.summary.totals.turns, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Launcher nối đầy đủ tab Usage và IPC launcher:usage-*", () => {
  assert.match(electronMain, /createUsageStore/);
  assert.match(ipcRouterSource, /handle\("launcher:usage-get"/);
  assert.match(ipcRouterSource, /handle\("launcher:usage-save-settings"/);
  assert.match(ipcRouterSource, /handle\("launcher:usage-clear"/);
  assert.match(preloadSource, /getUsage:/);
  assert.match(preloadSource, /saveUsageSettings:/);
  assert.match(preloadSource, /clearUsageHistory:/);
  assert.match(appSource, /<UsageSurface/);
  assert.match(appSource, /navigateSurface\("usage"\)/);
});
