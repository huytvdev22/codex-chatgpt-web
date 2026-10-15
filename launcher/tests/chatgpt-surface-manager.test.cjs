const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CHATGPT_HOME_URL,
  CHATGPT_TEMPORARY_CHAT_URL,
  ChatGptConversationStore,
  ChatGptSurfaceManager,
  chatGptConversationUrl,
  parseChatGptConversationId,
} = require("../electron/chatgpt-surface-manager.cjs");

const CONVERSATION_ID = "6704b2a8-5e88-800c-b26a-9bb7d24669f1";

test("ChatGPT conversation URLs accept only valid chatgpt.com /c/<id> paths", () => {
  const url = chatGptConversationUrl(CONVERSATION_ID);
  assert.equal(url, `https://chatgpt.com/c/${CONVERSATION_ID}`);
  assert.equal(parseChatGptConversationId(`${url}?source=codex`), CONVERSATION_ID);
  assert.equal(parseChatGptConversationId(`https://example.com/c/${CONVERSATION_ID}`), null);
  assert.equal(parseChatGptConversationId("https://chatgpt.com/c/short"), null);
});

test("ChatGPT Surface Manager generates Temporary Chat URL when useSavedChats is disabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-surface-temp-"));
  try {
    const manager = new ChatGptSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
      getUseSavedChats: () => false,
    });
    const key = "a".repeat(64);
    manager.bind(key, CONVERSATION_ID);
    assert.equal(manager.initialUrl(key), CHATGPT_TEMPORARY_CHAT_URL);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ChatGPT Surface Manager routes to existing chat URL when useSavedChats is enabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-surface-saved-"));
  try {
    let useSaved = true;
    const manager = new ChatGptSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
      getUseSavedChats: () => useSaved,
    });
    const key = "b".repeat(64);
    // Khi chưa có binding, vào trang chủ ChatGPT
    assert.equal(manager.initialUrl(key), CHATGPT_HOME_URL);

    // Sau khi bind conversation id, mở lại đúng URL chat cũ
    manager.bind(key, CONVERSATION_ID);
    assert.equal(manager.initialUrl(key), `https://chatgpt.com/c/${CONVERSATION_ID}`);
    assert.equal(manager.conversationId(key), CONVERSATION_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ChatGPT persistent bindings survive store recreation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-conversations-"));
  const file = path.join(root, "bindings.json");
  const key = "c".repeat(64);
  try {
    const first = new ChatGptConversationStore(file);
    first.bind(key, CONVERSATION_ID);
    assert.equal(new ChatGptConversationStore(file).get(key).conversationId, CONVERSATION_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ChatGPT supports up to three independent conversation surfaces by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-multi-surfaces-"));
  try {
    const manager = new ChatGptSurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
      getUseSavedChats: () => true,
    });
    const tabs = new Map([
      ["one", { id: "one", provider: "chatgpt", status: "running", conversationKey: "1".repeat(64) }],
      ["two", { id: "two", provider: "chatgpt", status: "running", conversationKey: "2".repeat(64) }],
    ]);
    manager.prepareAllocation(tabs, "3".repeat(64), () => assert.fail("capacity remains"));
    tabs.set("three", { id: "three", provider: "chatgpt", status: "running", conversationKey: "3".repeat(64) });
    assert.throws(
      () => manager.prepareAllocation(tabs, "4".repeat(64), () => assert.fail("must not remove running turns")),
      /already has 3 active conversation surfaces/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
