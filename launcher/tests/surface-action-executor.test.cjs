const test = require("node:test");
const assert = require("node:assert/strict");
const { SurfaceActionExecutor } = require("../electron/browser/surface-action-executor.cjs");

function createFakeHost(contents) {
  const tab = {
    id: "tab-exec-1",
    traceId: "trace_exec_01",
    helperPid: process.pid,
    provider: "ai-studio",
    status: "running",
    view: { webContents: contents },
  };
  return {
    provider: "ai-studio",
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    providerRegistry: {
      has: (id) => id === "ai-studio",
      get: (id) => (id === "ai-studio" ? { isAllowedNavigation: (u) => u.startsWith("https://aistudio.google.com/") } : null),
    },
  };
}

test("SurfaceActionExecutor pasteImages restores OS clipboard on native paste fallback", async () => {
  let clipText = "user-copied-secret";
  let clipImageEmpty = true;
  let pasteCalled = 0;

  const executor = new SurfaceActionExecutor({
    clipboard: {
      readText: () => clipText,
      readImage: () => ({ isEmpty: () => clipImageEmpty }),
      writeText: (val) => { clipText = val; clipImageEmpty = true; },
      writeImage: () => { clipImageEmpty = false; },
      clear: () => { clipText = ""; clipImageEmpty = true; },
    },
    nativeImage: {
      createFromBuffer: () => ({ isEmpty: () => false }),
    },
  });

  const contents = {
    isDestroyed: () => false,
    focus: () => {},
    getZoomFactor: () => 1,
    sendInputEvent: () => {},
    paste: () => { pasteCalled += 1; },
    executeJavaScript: async (expr) => {
      if (expr.includes("querySelectorAll(opts.selector)")) {
        return { found: true, x: 50, y: 60, disabled: false, text: "" };
      }
      if (expr.includes('new ClipboardEvent("paste"')) {
        return false; // giả lập rơi về native clipboard fallback
      }
      return true;
    },
  };

  const result = await executor.execute(createFakeHost(contents), {
    traceId: "trace_exec_01",
    helperPid: process.pid,
    action: "pasteImages",
    args: {
      files: [{ name: "shot.png", mimeType: "image/png", dataBase64: Buffer.from("PNG").toString("base64") }],
    },
  });

  assert.equal(result.attachedCount, 1);
  assert.equal(pasteCalled, 1);
  assert.equal(clipText, "user-copied-secret");
});

test("SurfaceActionExecutor aiStudioSelectThinkingLevel clicks matching option via trusted sendInputEvent", async () => {
  const executor = new SurfaceActionExecutor();
  const clicks = [];
  const contents = {
    isDestroyed: () => false,
    focus: () => {},
    getZoomFactor: () => 1,
    sendInputEvent: (ev) => {
      if (ev.type === "mouseDown") clicks.push([ev.x, ev.y]);
    },
    executeJavaScript: async (expr) => {
      if (expr.includes("querySelectorAll(opts.selector)")) {
        if (expr.includes("mat-mdc-select-panel") && expr.includes('"High"')) {
          return { found: true, x: 210, y: 310, disabled: false, text: "High" };
        }
        return { found: true, x: 180, y: 220, disabled: false, text: "Medium" };
      }
      if (expr.includes("document.querySelectorAll(sel).length")) {
        return 3;
      }
      return null;
    },
  };

  const result = await executor.execute(createFakeHost(contents), {
    traceId: "trace_exec_01",
    helperPid: process.pid,
    action: "aiStudioSelectThinkingLevel",
    args: { targetLevel: "High" },
  });

  assert.deepEqual(result, { changed: true });
  assert.deepEqual(clicks, [[180, 220], [210, 310]]);
});

test("SurfaceActionExecutor aiStudioCopyMarkdown prioritizes Copy as markdown over Copy as text", async () => {
  const executor = new SurfaceActionExecutor();
  const menuClicks = [];
  const contents = {
    isDestroyed: () => false,
    focus: () => {},
    getZoomFactor: () => 1,
    sendInputEvent: (ev) => {
      if (ev.type === "mouseDown") menuClicks.push([ev.x, ev.y]);
    },
    executeJavaScript: async (expr) => {
      if (expr.includes("window.__aistudio_clipboard_hooked")) return null;
      if (expr.includes("document.querySelectorAll(sel).length") && expr.includes("chat-turn-container")) return 1;
      if (expr.includes("window.__aistudio_last_copied_markdown") && expr.includes("val.trim()")) {
        return "````markdown\n<webResponse>\nFrom hook\n</webResponse>\n````";
      }
      if (expr.includes("button.mat-mdc-menu-item") && expr.includes(".map(")) {
        return ["delete\nDelete", "content_copy\nCopy as text", "markdown_copy\nCopy as markdown"];
      }
      if (expr.includes("querySelectorAll('button.mat-mdc-menu-item').length")) return 3;
      if (expr.includes("document.querySelectorAll('div.mat-mdc-menu-panel")) return 0;
      if (expr.includes("querySelectorAll(opts.selector)")) {
        if (expr.includes("mat-mdc-menu-item")) {
          return { found: true, x: 300, y: 400, disabled: false, text: "Copy as markdown" };
        }
        return { found: true, x: 100, y: 120, disabled: false, text: "Open options" };
      }
      return null;
    },
  };

  const res = await executor.execute(createFakeHost(contents), {
    traceId: "trace_exec_01",
    helperPid: process.pid,
    action: "aiStudioCopyMarkdown",
    args: { baselineAnswerCount: 0 },
  });

  assert.equal(res.text, "````markdown\n<webResponse>\nFrom hook\n</webResponse>\n````");
  assert.deepEqual(menuClicks, [[100, 120], [300, 400]]);
});

test("SurfaceActionExecutor aiStudioWaitForBotGuardReady settles immediately once WAA is ready and respects maxWaitMs cap", async () => {
  const executor = new SurfaceActionExecutor();
  let waaReady = true;
  let pageAgeMs = 1500;
  const contents = {
    isDestroyed: () => false,
    executeJavaScript: async () => ({ waaReady, pageAgeMs }),
  };

  const quickRes = await executor.execute(createFakeHost(contents), {
    traceId: "trace_exec_01",
    helperPid: process.pid,
    action: "aiStudioWaitForBotGuardReady",
    args: { minPageAgeMs: 1200, maxWaitMs: 500 },
  });
  assert.equal(quickRes.settled, true);
  assert.equal(quickRes.waaReady, true);
  assert.ok(quickRes.elapsedMs < 50);

  waaReady = false;
  pageAgeMs = 100;
  const cappedRes = await executor.execute(createFakeHost(contents), {
    traceId: "trace_exec_01",
    helperPid: process.pid,
    action: "aiStudioWaitForBotGuardReady",
    args: { minPageAgeMs: 1200, maxWaitMs: 120 },
  });
  assert.equal(cappedRes.settled, true);
  assert.equal(cappedRes.waaReady, false);
  assert.ok(cappedRes.elapsedMs >= 100);
});

test("SurfaceActionExecutor aiStudioSpeechConfigureSpeakers maps fixed card aliases without swapping voices and retries failed click", async () => {
  const executor = new SurfaceActionExecutor();
  const cards = [
    { alias: "Speaker 1", voice: "Puck" },
    { alias: "Speaker 2", voice: "Zephyr" },
  ];
  let openedCardIdx = -1;
  let drawerOpen = false;
  let aoedeClickAttempts = 0;

  const contents = {
    isDestroyed: () => false,
    focus: () => {},
    getZoomFactor: () => 1,
    sendInputEvent: (ev) => {
      if (ev.type !== "mouseUp") return;
      if (ev.x === 10 && ev.y === 10) {
        openedCardIdx = 0;
        drawerOpen = true;
      } else if (ev.x === 20 && ev.y === 20) {
        openedCardIdx = 1;
        drawerOpen = true;
      } else if (ev.x === 300 && ev.y === 300 && openedCardIdx >= 0) {
        // Click vào Charon thành công ngay
        cards[openedCardIdx].voice = "Charon";
      } else if (ev.x === 400 && ev.y === 400 && openedCardIdx >= 0) {
        aoedeClickAttempts += 1;
        // Lần đầu trượt thành Autonoe, lần 2 mới chọn đúng Aoede
        cards[openedCardIdx].voice = aoedeClickAttempts === 1 ? "Autonoe" : "Aoede";
      } else if (ev.x === 999 && ev.y === 10) {
        drawerOpen = false;
      }
    },
    executeJavaScript: async (expr) => {
      // readCardSnapshot
      if (expr.includes("currentVoiceLower") && expr.includes("hasAliasInput")) {
        return cards.map((c, idx) => ({
          index: idx,
          alias: c.alias,
          aliasLower: c.alias.toLowerCase(),
          hasAliasInput: false,
          currentVoice: c.voice,
          currentVoiceLower: c.voice.toLowerCase(),
        }));
      }
      // ensureAiStudioVoicesDrawerClosed check
      if (expr.includes("const el = document.querySelector(sel)") && expr.includes("rect.width > 0 && rect.height > 0")) {
        return drawerOpen;
      }
      // queryElementCenter for trigger / close panel
      if (expr.includes("querySelectorAll(opts.selector)")) {
        if (expr.includes("active-voice-card-trigger")) {
          const idx = expr.includes('"containerNth":0') ? 0 : 1;
          return { found: true, x: idx === 0 ? 10 : 20, y: idx === 0 ? 10 : 20, disabled: false, text: cards[idx].voice };
        }
        if (expr.includes("Close panel")) {
          return drawerOpen ? { found: true, x: 999, y: 10, disabled: false, text: "Close" } : { found: false };
        }
        if (expr.includes("voice persona")) {
          return { found: false };
        }
        return { found: false };
      }
      // waitForSelector availableVoices
      if (expr.includes("document.querySelectorAll(sel)") && expr.includes("Available voices")) {
        return drawerOpen;
      }
      // scrollRes
      if (expr.includes("alreadyCurrent") && expr.includes("findVoiceBtn")) {
        const needle = expr.includes('"aoede"') ? "aoede" : "charon";
        const cur = (cards[openedCardIdx]?.voice || "").toLowerCase();
        return { found: true, alreadyCurrent: cur === needle };
      }
      // coordsRes
      if (expr.includes("playRect") && expr.includes("findVoiceBtn")) {
        const isAoede = expr.includes('"aoede"');
        return { found: true, x: isAoede ? 400 : 300, y: isAoede ? 400 : 300 };
      }
      // verifyRes
      if (expr.includes("cardMatched") && expr.includes("findVoiceBtn")) {
        const needle = expr.includes('"aoede"') ? "aoede" : "charon";
        const cur = cards[openedCardIdx]?.voice || "";
        return { verified: cur.toLowerCase() === needle, cardVoice: cur };
      }
      return null;
    },
  };

  const result = await executor.execute(createFakeHost(contents), {
    traceId: "trace_exec_01",
    helperPid: process.pid,
    action: "aiStudioSpeechConfigureSpeakers",
    args: {
      orderedSpeakers: [
        { speaker: "Speaker 2", voiceName: "Aoede" },
        { speaker: "Speaker 1", voiceName: "Charon" },
      ],
    },
  });

  assert.equal(result.configured, 2);
  assert.equal(aoedeClickAttempts, 2, "Phải tự retry click khi lần đầu trượt sang Autonoe");
  assert.deepEqual(cards, [
    { alias: "Speaker 1", voice: "Charon" },
    { alias: "Speaker 2", voice: "Aoede" },
  ]);
});
