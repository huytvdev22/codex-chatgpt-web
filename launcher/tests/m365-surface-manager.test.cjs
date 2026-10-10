const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  M365_CHAT_URL,
  M365ConversationStore,
  M365SurfaceManager,
  m365ConversationUrl,
  parseM365ConversationId,
} = require("../electron/m365-surface-manager.cjs");
const { allowedM365Navigation } = require("../electron/m365-turn-surface.cjs");

const CONVERSATION_ID = "8cbbbab7-10a3-4f92-950e-f0a1b18b8f89";

test("M365 conversation URLs accept only the exact Microsoft origin and UUID path", () => {
  const url = m365ConversationUrl(CONVERSATION_ID);
  assert.equal(url, `${M365_CHAT_URL}/conversation/${CONVERSATION_ID}`);
  assert.equal(parseM365ConversationId(`${url}?source=codex`), CONVERSATION_ID);
  assert.equal(parseM365ConversationId(`https://example.com/chat/conversation/${CONVERSATION_ID}`), null);
  assert.equal(parseM365ConversationId(`${M365_CHAT_URL}/conversation/not-a-uuid`), null);
});

test("M365 turn surfaces allow normal conversation navigation but reject foreign origins", () => {
  assert.equal(allowedM365Navigation(`${M365_CHAT_URL}/conversation/${CONVERSATION_ID}`), true);
  assert.equal(allowedM365Navigation("https://login.microsoftonline.com/common/oauth2/authorize"), true);
  assert.equal(allowedM365Navigation("https://example.com/chat"), false);
  assert.equal(allowedM365Navigation("javascript:alert(1)"), false);
});

test("M365 persistent bindings survive launcher store recreation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m365-conversations-"));
  const file = path.join(root, "bindings.json");
  const key = "a".repeat(64);
  try {
    const first = new M365ConversationStore(file);
    first.bind(key, CONVERSATION_ID.toUpperCase());
    assert.equal(new M365ConversationStore(file).get(key).conversationId, CONVERSATION_ID);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M365 supports three independent conversation surfaces by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m365-multi-surfaces-"));
  try {
    const manager = new M365SurfaceManager({
      descriptorPath: path.join(root, "launcher-browser.json"),
    });
    const tabs = new Map([
      ["one", { id: "one", provider: "m365", status: "running", conversationKey: "1".repeat(64) }],
      ["two", { id: "two", provider: "m365", status: "running", conversationKey: "2".repeat(64) }],
    ]);
    manager.prepareAllocation(tabs, "3".repeat(64), () => assert.fail("capacity remains"));
    tabs.set("three", { id: "three", provider: "m365", status: "running", conversationKey: "3".repeat(64) });
    assert.throws(
      () => manager.prepareAllocation(tabs, "4".repeat(64), () => assert.fail("must not remove running turns")),
      /already has 3 active conversation surfaces/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
