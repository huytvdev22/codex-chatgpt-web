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
