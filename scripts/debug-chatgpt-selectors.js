/*
 * ChatGPT DOM selector probe
 *
 * Cách dùng:
 * 1. Mở đúng tab ChatGPT đang được Launcher điều khiển.
 * 2. Mở Chrome DevTools > Console.
 * 3. Dán toàn bộ file này rồi nhấn Enter.
 * 4. Gửi một prompt mới.
 * 5. Sau khi ChatGPT bắt đầu hoặc hoàn tất phản hồi, chạy:
 *      chatGptSelectorProbe.snapshot()
 * 6. Để theo dõi mutation trong 2 phút:
 *      chatGptSelectorProbe.start()
 *    Dừng và lấy báo cáo:
 *      chatGptSelectorProbe.stop()
 * 7. Sao chép báo cáo JSON:
 *      copy(chatGptSelectorProbe.report())
 */
(() => {
  const SELECTORS = {
    composer: [
      'div.ProseMirror[data-composer-markdown][role="textbox"]',
      '#prompt-textarea',
      'div[contenteditable="true"][role="textbox"]',
      'div.ProseMirror',
    ],
    sendButton: [
      'button[data-testid="send-button"]',
      'button[type="submit"][aria-label="Send"]',
      'button[type="submit"][aria-label="Send prompt"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'button[aria-label="Gửi"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Gửi" i]',
      'button[type="submit"]',
      'form button[type="submit"]',
    ],
    stopButton: [
      'button[type="button"][aria-label="Stop"]',
      'button[aria-label="Stop generating"]',
      'button[data-testid="stop-button"]',
    ],
    assistantMessage: [
      '[data-markdown-text-style="assistant-message"]',
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"] [class*="markdown"]',
    ],
    assistantCandidates: [
      '[data-message-author-role="assistant"]',
      '[data-conversation-role="assistant"]',
      'article[data-testid^="conversation-turn-"]',
      'div[data-chatgpt-selection-message-id]',
      '[data-content-search-unit-key]',
    ],
    userMessage: [
      '[data-message-author-role="user"]',
      '[data-conversation-role="user"]',
      '[data-user-message-bubble]',
    ],
    codeBlock: [
      'div[data-code-block="true"]',
      '.CodeBlock-zu1QM3',
      'pre',
    ],
    copyCodeButton: [
      'button[aria-label="Copy code"]',
      'div[data-code-block="true"] button[aria-label="Copy code"]',
      'button:has(svg use[href*="copy"])',
    ],
    copyMessageButton: [
      'button[aria-label="Copy"]',
      'button[data-testid="copy-turn-action-button"]',
    ],
  };

  const state = {
    startedAt: null,
    stoppedAt: null,
    observer: null,
    timer: null,
    snapshots: [],
    mutations: [],
    lastSignature: "",
  };

  const text = element =>
    (element?.innerText || element?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

  const visible = element => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const describe = (element, index) => {
    const rect = element.getBoundingClientRect();
    const article = element.closest('article[data-testid^="conversation-turn-"]');
    const author = element.closest("[data-message-author-role]");
    const roleMarker = element.closest("[data-conversation-role]");
    return {
      index,
      tag: element.tagName.toLowerCase(),
      visible: visible(element),
      connected: element.isConnected,
      textLength: text(element).length,
      textPreview: text(element).slice(0, 180),
      id: element.id || null,
      className:
        typeof element.className === "string"
          ? element.className.slice(0, 180)
          : null,
      ariaLabel: element.getAttribute("aria-label"),
      testId: element.getAttribute("data-testid"),
      selectionMessageId: element.getAttribute(
        "data-chatgpt-selection-message-id",
      ),
      messageAuthorRole:
        element.getAttribute("data-message-author-role") ||
        author?.getAttribute("data-message-author-role") ||
        null,
      conversationRole:
        element.getAttribute("data-conversation-role") ||
        roleMarker?.getAttribute("data-conversation-role") ||
        null,
      conversationTurn: article?.getAttribute("data-testid") || null,
      rect: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  };

  const inspectGroup = selectors => {
    const seen = new Set();
    const alternatives = selectors.map(selector => {
      let elements = [];
      let error = null;
      try {
        elements = Array.from(document.querySelectorAll(selector));
      } catch (caught) {
        error = String(caught);
      }

      const uniqueElements = elements.filter(element => {
        if (seen.has(element)) return false;
        seen.add(element);
        return true;
      });

      return {
        selector,
        error,
        rawCount: elements.length,
        uniqueCount: uniqueElements.length,
        visibleCount: uniqueElements.filter(visible).length,
        matches: uniqueElements.map(describe),
      };
    });

    return {
      rawTotal: alternatives.reduce((sum, item) => sum + item.rawCount, 0),
      uniqueTotal: seen.size,
      alternatives,
    };
  };

  const turnInventory = () =>
    Array.from(
      document.querySelectorAll('article[data-testid^="conversation-turn-"]'),
    ).map((turn, index) => ({
      ...describe(turn, index),
      containsUser: Boolean(
        turn.querySelector(
          '[data-message-author-role="user"], [data-conversation-role="user"], [data-user-message-bubble]',
        ),
      ),
      containsAssistant: Boolean(
        turn.querySelector(
          '[data-message-author-role="assistant"], [data-conversation-role="assistant"], [data-markdown-text-style="assistant-message"]',
        ),
      ),
      markdownRoots: turn.querySelectorAll(
        '[data-markdown-text-style="assistant-message"], .markdown, [class*="markdown"]',
      ).length,
      copyButtons: turn.querySelectorAll(
        'button[aria-label="Copy code"], button[aria-label="Copy"], button[data-testid="copy-turn-action-button"]',
      ).length,
    }));

  const createSnapshot = reason => {
    const groups = Object.fromEntries(
      Object.entries(SELECTORS).map(([name, selectors]) => [
        name,
        inspectGroup(selectors),
      ]),
    );
    const snapshot = {
      reason,
      timestamp: new Date().toISOString(),
      url: location.href,
      title: document.title,
      documentReadyState: document.readyState,
      groups,
      turns: turnInventory(),
    };

    const signature = JSON.stringify({
      assistant: groups.assistantMessage.alternatives.map(item => [
        item.selector,
        item.rawCount,
        item.matches.map(match => match.textLength),
      ]),
      stop: groups.stopButton.rawTotal,
      send: groups.sendButton.rawTotal,
      turns: snapshot.turns.map(turn => [
        turn.conversationTurn,
        turn.containsUser,
        turn.containsAssistant,
        turn.textLength,
      ]),
    });

    if (signature !== state.lastSignature || reason === "manual") {
      state.lastSignature = signature;
      state.snapshots.push(snapshot);
      if (state.snapshots.length > 120) state.snapshots.shift();
      console.groupCollapsed(
        `[ChatGPT selector probe] ${reason} | assistant=${groups.assistantMessage.uniqueTotal} | stop=${groups.stopButton.uniqueTotal} | send=${groups.sendButton.uniqueTotal}`,
      );
      console.table(
        Object.entries(groups).map(([name, group]) => ({
          group: name,
          rawMatches: group.rawTotal,
          uniqueElements: group.uniqueTotal,
        })),
      );
      console.table(snapshot.turns);
      console.log(snapshot);
      console.groupEnd();
    }

    return snapshot;
  };

  const start = () => {
    if (state.observer) {
      console.warn("[ChatGPT selector probe] Probe đã chạy.");
      return;
    }

    state.startedAt = new Date().toISOString();
    state.stoppedAt = null;
    state.snapshots = [];
    state.mutations = [];
    state.lastSignature = "";

    state.observer = new MutationObserver(records => {
      const summary = {
        timestamp: new Date().toISOString(),
        records: records.length,
        addedNodes: records.reduce(
          (sum, record) => sum + record.addedNodes.length,
          0,
        ),
        removedNodes: records.reduce(
          (sum, record) => sum + record.removedNodes.length,
          0,
        ),
        attributeChanges: records.filter(
          record => record.type === "attributes",
        ).length,
      };
      state.mutations.push(summary);
      if (state.mutations.length > 500) state.mutations.shift();
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "aria-pressed",
        "data-testid",
        "data-message-author-role",
        "data-conversation-role",
        "data-markdown-text-style",
        "class",
      ],
    });

    state.timer = setInterval(() => createSnapshot("poll"), 1000);
    createSnapshot("start");
    console.log(
      "[ChatGPT selector probe] Đã theo dõi DOM mỗi 1 giây. Chạy chatGptSelectorProbe.stop() để dừng.",
    );
  };

  const stop = () => {
    if (state.timer) clearInterval(state.timer);
    if (state.observer) state.observer.disconnect();
    state.timer = null;
    state.observer = null;
    state.stoppedAt = new Date().toISOString();
    createSnapshot("stop");
    const result = report();
    console.log("[ChatGPT selector probe] Đã dừng.", result);
    return result;
  };

  const snapshot = () => createSnapshot("manual");

  const report = () => ({
    probeVersion: 1,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    url: location.href,
    selectorDefinitions: SELECTORS,
    mutationSamples: state.mutations,
    snapshots: state.snapshots,
  });

  const compare = () => {
    const current = snapshot();
    return Object.fromEntries(
      Object.entries(current.groups).map(([name, group]) => [
        name,
        group.alternatives.map(item => ({
          selector: item.selector,
          rawCount: item.rawCount,
          uniqueCount: item.uniqueCount,
          visibleCount: item.visibleCount,
          error: item.error,
        })),
      ]),
    );
  };

  window.chatGptSelectorProbe = {
    selectors: SELECTORS,
    start,
    stop,
    snapshot,
    compare,
    report,
  };

  console.log(
    "[ChatGPT selector probe] Đã cài đặt. Chạy chatGptSelectorProbe.start() trước khi gửi prompt.",
  );
  console.table(compare());
})();
