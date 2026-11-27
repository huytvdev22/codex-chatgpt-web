const assert = require("node:assert/strict");
const test = require("node:test");
const { TurnTabManager } = require("../electron/browser/turn-tab-manager.cjs");

function createStubHost(initialTabs) {
  const turnTabs = new Map();
  for (const tab of initialTabs) {
    turnTabs.set(tab.id, tab);
  }
  const removed = [];
  const host = {
    provider: "gemini",
    selectedTabId: "primary",
    turnTabs,
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    lastClosedAtByProvider: new Map(),
    removeTurnTab(tab) {
      removed.push(tab.id);
      this.turnTabs.delete(tab.id);
    },
  };
  return { host, removed };
}

test("TurnTabManager ưu tiên evict tab assistant trước tab VS Code cũ hơn", () => {
  const { host, removed } = createStubHost([
    {
      id: "tab-vscode-old",
      conversationKey: "a".repeat(64),
      connectorIdentity: "gemini",
      conversationId: "conv-v1",
      status: "ready",
      lastHeartbeatAt: 1000,
      label: "Gemini 1",
    },
    {
      id: "tab-bot-new",
      conversationKey: "b".repeat(64),
      connectorIdentity: "gemini:assistant",
      conversationId: "conv-b1",
      status: "ready",
      lastHeartbeatAt: 9000,
      label: "[BOT] GEMINI 2",
    },
  ]);

  const manager = new TurnTabManager(host, { standalone: true });
  const evicted = manager.evictOldestRetainedTurnTab();

  assert.equal(evicted, true);
  assert.deepEqual(removed, ["tab-bot-new"]);
  assert.equal(host.turnTabs.has("tab-vscode-old"), true);
});

test("TurnTabManager giới hạn tối đa 3 tab assistant retained và không chạm tab VS Code", () => {
  const { host, removed } = createStubHost([
    {
      id: "tab-vscode-1",
      conversationKey: "1".repeat(64),
      connectorIdentity: "gemini",
      conversationId: "conv-v1",
      status: "ready",
      lastHeartbeatAt: 100,
      label: "Gemini 1",
    },
    {
      id: "tab-bot-1",
      conversationKey: "2".repeat(64),
      connectorIdentity: "gemini:assistant",
      conversationId: "conv-b1",
      status: "ready",
      lastHeartbeatAt: 1000,
      label: "[BOT] GEMINI 2",
    },
    {
      id: "tab-bot-2",
      conversationKey: "3".repeat(64),
      connectorIdentity: "gemini:assistant",
      conversationId: "conv-b2",
      status: "ready",
      lastHeartbeatAt: 2000,
      label: "[BOT] GEMINI 3",
    },
    {
      id: "tab-bot-3",
      conversationKey: "4".repeat(64),
      connectorIdentity: "gemini:assistant",
      conversationId: "conv-b3",
      status: "ready",
      lastHeartbeatAt: 3000,
      label: "[BOT] GEMINI 4",
    },
    {
      id: "tab-bot-4",
      conversationKey: "5".repeat(64),
      connectorIdentity: "gemini:assistant",
      conversationId: "conv-b4",
      status: "ready",
      lastHeartbeatAt: 4000,
      label: "[BOT] GEMINI 5",
    },
  ]);

  const manager = new TurnTabManager(host, { standalone: true });
  manager.trimAssistantRetainedTabs("tab-bot-4");

  assert.deepEqual(removed, ["tab-bot-1"]);
  assert.equal(host.turnTabs.has("tab-vscode-1"), true);
  assert.equal(host.turnTabs.has("tab-bot-4"), true);
  assert.equal(host.turnTabs.size, 4);
});
