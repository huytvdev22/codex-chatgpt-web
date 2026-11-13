const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  QWEN_HOME_URL,
  QwenConversationStore,
  QwenSurfaceManager,
  qwenConversationUrl,
  parseQwenConversationId,
} = require("../electron/qwen-surface-manager.cjs");

const CONVERSATION_ID = "58703ee0-04f5-4621-b17a-b20201be1ead";

test("Qwen conversation URLs accept only valid chat.qwen.ai /c/<id> paths", () => {
  const url = qwenConversationUrl(CONVERSATION_ID);
  assert.equal(url, `https://chat.qwen.ai/c/${CONVERSATION_ID}`);
  assert.equal(parseQwenConversationId(`${url}?source=codex`), CONVERSATION_ID);
  assert.equal(parseQwenConversationId(`https://example.com/c/${CONVERSATION_ID}`), null);
  assert.equal(parseQwenConversationId("https://chat.qwen.ai/c/short"), null);
});

test("Qwen Surface Manager routes to existing chat URL or home page", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-surface-saved-"));
  try {
    const manager = new QwenSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
    });
    const key = "b".repeat(64);
    // Khi chưa có binding, vào trang chủ Qwen
    assert.equal(manager.initialUrl(key), QWEN_HOME_URL);

    // Sau khi bind conversation id, mở lại đúng URL chat cũ
    manager.bind(key, CONVERSATION_ID);
    assert.equal(manager.initialUrl(key), `https://chat.qwen.ai/c/${CONVERSATION_ID}`);
    assert.equal(manager.conversationId(key), CONVERSATION_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Qwen persistent bindings survive store recreation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-conversations-"));
  const file = path.join(root, "bindings.json");
  const key = "c".repeat(64);
  try {
    const first = new QwenConversationStore(file);
    first.bind(key, CONVERSATION_ID);
    assert.equal(new QwenConversationStore(file).get(key).conversationId, CONVERSATION_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Qwen supports up to three independent conversation surfaces by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-multi-surfaces-"));
  try {
    const manager = new QwenSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
    });
    const tabs = new Map([
      ["one", { id: "one", provider: "qwen", status: "running", conversationKey: "1".repeat(64) }],
      ["two", { id: "two", provider: "qwen", status: "running", conversationKey: "2".repeat(64) }],
    ]);
    manager.prepareAllocation(tabs, "3".repeat(64), () => assert.fail("capacity remains"));
    tabs.set("three", { id: "three", provider: "qwen", status: "running", conversationKey: "3".repeat(64) });
    assert.throws(
      () => manager.prepareAllocation(tabs, "4".repeat(64), () => assert.fail("must not remove running turns")),
      /already has 3 active conversation surfaces/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("Qwen prepares allocation by reclaiming stale/ready tabs with the same conversation key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-same-key-"));
  try {
    const manager = new QwenSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
    });
    const key = "a".repeat(64);
    const removed = [];
    const tabs = new Map([
      ["old-ready", { id: "old-ready", provider: "qwen", status: "ready", conversationKey: key, lastHeartbeatAt: 100 }],
      ["other-ready", { id: "other-ready", provider: "qwen", status: "ready", conversationKey: "b".repeat(64), lastHeartbeatAt: 200 }],
    ]);

    manager.prepareAllocation(tabs, key, (tab) => {
      removed.push(tab.id);
      tabs.delete(tab.id);
    });

    assert.equal(removed.includes("old-ready"), true, "Must reclaim existing tab with the same conversation key");
    assert.equal(tabs.has("old-ready"), false);
    assert.equal(tabs.has("other-ready"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Qwen prepareAllocation rejects allocation if conversation key has an active running turn with alive helper", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-active-conflict-"));
  try {
    const manager = new QwenSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
    });
    const key = "c".repeat(64);
    const tabs = new Map([
      ["active-tab", { id: "active-tab", provider: "qwen", status: "running", helperPid: process.pid, conversationKey: key, lastHeartbeatAt: Date.now() }],
    ]);

    assert.throws(
      () => manager.prepareAllocation(tabs, key, () => {}),
      /Qwen Web conversation is currently active with another turn/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Qwen prepareAllocation cleans up orphan running tabs whose helper process has exited", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-orphan-cleanup-"));
  try {
    const manager = new QwenSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
    });
    const key = "d".repeat(64);
    const removed = [];
    // PID 99999999 hầu như chắc chắn không tồn tại
    const tabs = new Map([
      ["orphan-tab", { id: "orphan-tab", provider: "qwen", status: "running", helperPid: 99999999, conversationKey: key }],
    ]);

    manager.prepareAllocation(tabs, key, (tab) => {
      removed.push(tab.id);
      tabs.delete(tab.id);
    });

    assert.deepEqual(removed, ["orphan-tab"], "Must remove orphan running tab when helper process is dead");
    assert.equal(tabs.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Qwen prepareAllocation reclaims running tab whose heartbeat is stale even if helper process is alive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-stale-heartbeat-"));
  try {
    const manager = new QwenSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
      staleTurnHeartbeatMs: 1_000,
    });
    const key = "e".repeat(64);
    const removed = [];
    const tabs = new Map([
      ["stuck-tab", {
        id: "stuck-tab",
        provider: "qwen",
        status: "running",
        helperPid: process.pid,
        conversationKey: key,
        lastHeartbeatAt: Date.now() - 5_000,
      }],
    ]);

    manager.prepareAllocation(tabs, key, (tab) => {
      removed.push(tab.id);
      tabs.delete(tab.id);
    });

    assert.deepEqual(removed, ["stuck-tab"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Qwen waitForActiveTurn waits until the previous same-key turn releases its tab", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-wait-active-"));
  try {
    const manager = new QwenSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
      activeTurnWaitMs: 2_000,
      activeTurnPollMs: 10,
    });
    const key = "f".repeat(64);
    const previous = {
      id: "prev",
      provider: "qwen",
      status: "running",
      traceId: "trace-old",
      helperPid: process.pid,
      conversationKey: key,
      lastHeartbeatAt: Date.now(),
    };
    const tabs = new Map([["prev", previous]]);
    setTimeout(() => { previous.status = "ready"; }, 50);

    const released = await manager.waitForActiveTurn(tabs, key, "trace-new");

    assert.equal(released, true);
    assert.equal(previous.status, "ready");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Qwen waitForActiveTurn gives up after its bounded wait and ignores its own trace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-wait-timeout-"));
  try {
    const manager = new QwenSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
      activeTurnWaitMs: 50,
      activeTurnPollMs: 10,
    });
    const key = "9".repeat(64);
    const tabs = new Map([["busy", {
      id: "busy",
      provider: "qwen",
      status: "running",
      traceId: "trace-busy",
      helperPid: process.pid,
      conversationKey: key,
      lastHeartbeatAt: Date.now(),
    }]]);

    assert.equal(await manager.waitForActiveTurn(tabs, key, "trace-other"), false);
    assert.equal(await manager.waitForActiveTurn(tabs, key, "trace-busy"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
