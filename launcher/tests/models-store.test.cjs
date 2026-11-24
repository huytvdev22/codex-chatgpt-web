const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  createModelsStore,
} = require("../electron/infra/models-store.cjs");

test("launcher models store manages models.json offline and prevents disabling the last model", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-models-launcher-offline-"));
  const file = path.join(root, "models.json");
  try {
    const store = createModelsStore(file, () => null);
    const initial = await store.getSnapshot();
    assert.equal(initial.totalEnabledCount, 6);

    const afterEdit = await store.updateOverride("chatgpt/gpt-6", {
      displayName: "GPT-6 Offline Custom",
      contextWindow: 256_000,
      inputModalities: ["text"],
      defaultReasoningLevel: "high",
    });
    const edited = afterEdit.providers
      .find(p => p.providerId === "chatgpt")
      .models.find(m => m.slug === "chatgpt/gpt-6");
    assert.equal(edited.displayName, "GPT-6 Offline Custom");
    assert.equal(edited.contextWindow, 256_000);
    assert.equal(edited.autoCompactTokenLimit, 230_400);
    assert.deepEqual(edited.inputModalities, ["text"]);
    assert.equal(edited.defaultReasoningLevel, "high");

    await store.toggleProvider("m365-copilot", false);
    await store.toggleProvider("ai-studio", false);
    await store.updateOverride("chatgpt/gpt-6", { enabled: false });
    await store.updateOverride("chatgpt/gpt-5.6-sol", { enabled: false });

    await assert.rejects(
      () => store.updateOverride("chatgpt/gpt-6.2", { enabled: false }),
      /At least one available model/,
    );

    await assert.rejects(
      () => store.refreshModels("chatgpt"),
      /runtime is offline/i,
    );

    const ensured = store.ensureConfigFileExists();
    assert.equal(ensured, file);
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher models store proxies online requests to runtime /admin/models*", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-models-launcher-online-"));
  const file = path.join(root, "models.json");
  const seenRequests = [];

  const server = http.createServer((req, res) => {
    let rawBody = "";
    req.on("data", chunk => { rawBody += chunk; });
    req.on("end", () => {
      seenRequests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : null,
      });
      res.setHeader("content-type", "application/json");
      if (req.url === "/admin/models/refresh") {
        res.end(JSON.stringify({
          status: "ok",
          snapshot: { version: 1, updatedAt: "2026-11-24T00:00:00Z", configPath: file, totalEnabledCount: 6, providers: [] },
          results: [{ providerId: "chatgpt", status: "ok", addedCount: 1, updatedCount: 3, unavailableCount: 0, discoveredCount: 4 }],
        }));
        return;
      }
      res.end(JSON.stringify({
        status: "ok",
        snapshot: { version: 1, updatedAt: null, configPath: file, totalEnabledCount: 5, providers: [] },
      }));
    });
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const store = createModelsStore(file, () => ({
      host: "127.0.0.1",
      port: address.port,
      controlToken: "secret-tok",
    }));

    const snap = await store.getSnapshot();
    assert.equal(snap.totalEnabledCount, 5);

    const refresh = await store.refreshModels("chatgpt");
    assert.equal(refresh.results[0].addedCount, 1);

    assert.equal(seenRequests[0].auth, "Bearer secret-tok");
    assert.equal(seenRequests[1].url, "/admin/models/refresh");
    assert.deepEqual(seenRequests[1].body, { providerId: "chatgpt" });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
