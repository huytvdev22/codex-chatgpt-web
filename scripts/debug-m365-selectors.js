/*
 * Microsoft 365 Copilot DOM selector probe
 *
 * Mục tiêu:
 * - Kiểm tra từng selector riêng lẻ thay vì chỉ kiểm tra selector fallback đã join.
 * - Phát hiện selector quá rộng, match phần tử ẩn, editor code, nút sai chức năng
 *   hoặc nhiều phần tử cùng lúc.
 * - Ghi nhận selector thực sự hoạt động ở các trạng thái idle, generating và completed.
 *
 * Cách dùng:
 * 1. Mở đúng tab Microsoft 365 Copilot đang được Launcher điều khiển.
 * 2. Mở Chrome DevTools > Console.
 * 3. Dán toàn bộ file này rồi nhấn Enter.
 * 4. Chạy lần lượt:
 *
 *      m365SelectorProbe.snapshot("idle")
 *
 *    Sau đó gửi prompt, trong lúc đang sinh phản hồi:
 *
 *      m365SelectorProbe.snapshot("generating")
 *
 *    Sau khi hoàn tất:
 *
 *      m365SelectorProbe.snapshot("completed")
 *
 * 5. Có thể tự theo dõi thay đổi DOM:
 *
 *      m365SelectorProbe.start()
 *      m365SelectorProbe.stop()
 *
 * 6. Xem đề xuất selector nên giữ hoặc loại bỏ:
 *
 *      m365SelectorProbe.recommend()
 *
 * 7. Sao chép báo cáo JSON:
 *
 *      m365SelectorProbe.copyReport()
 *
 * Script chỉ đọc DOM, không click, không nhập nội dung và không gửi prompt.
 */
(() => {
  const ROOT_KEY = "__m365SelectorProbe";
  const previousProbe = window[ROOT_KEY];
  if (previousProbe?.stop) previousProbe.stop();

  const SELECTOR_GROUPS = {
    editor: [
      "#m365-chat-editor-target-element",
      '.fai-BebopLiteChatInput [role="textbox"]',
      '.fai-ChatInput [role="textbox"]',
      'div[contenteditable="true"]:not([aria-readonly="true"]):not([aria-label*="Code editor" i])',
      '[role="textbox"]:not([aria-readonly="true"]):not([aria-label*="Code editor" i])',
      'textarea:not([aria-readonly="true"])',
    ],
    inputWrapper: [
      ".fai-BebopLiteChatInput__inputWrapper",
    ],
    actions: [
      ".fai-BebopLiteChatInput__actions",
    ],
    sendButton: [
      'button[type="submit"][aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon))',
      'button[aria-label="Send"]:not([aria-label*="Stop"]):not(:has(.fai-SendButton__stopIcon))',
      '.fai-BebopLiteChatInput__actions button[type="submit"]:has(.fai-SendButton__sendIcon):not(:has(.fai-SendButton__stopIcon))',
    ],
    stopButton: [
      'button[type="submit"][aria-label="Stop generating"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Dừng tạo" i]',
      ".fai-SendButton__stopIcon",
      '[data-testid="stop-button"]',
    ],
    dictationButton: [
      'button[aria-label="Start dictation"]',
    ],
  };

  const state = {
    startedAt: new Date().toISOString(),
    snapshots: [],
    mutations: [],
    observer: null,
    mutationTimer: null,
  };

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function escapeCss(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function elementPath(element) {
    if (!(element instanceof Element)) return "";
    const parts = [];
    let cursor = element;
    while (cursor && parts.length < 6) {
      let part = cursor.tagName.toLowerCase();
      if (cursor.id) {
        part += `#${escapeCss(cursor.id)}`;
        parts.unshift(part);
        break;
      }
      const classes = Array.from(cursor.classList)
        .filter(Boolean)
        .slice(0, 2)
        .map(name => `.${escapeCss(name)}`)
        .join("");
      part += classes;
      const parent = cursor.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          sibling => sibling.tagName === cursor.tagName,
        );
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(cursor) + 1})`;
        }
      }
      parts.unshift(part);
      cursor = parent;
    }
    return parts.join(" > ");
  }

  function describeElement(element) {
    const rect = element.getBoundingClientRect();
    const ariaLabel = element.getAttribute("aria-label") || "";
    const role = element.getAttribute("role") || "";
    const tag = element.tagName.toLowerCase();
    const text = (element.textContent || "").trim().replace(/\s+/g, " ");
    const contentEditable = element.getAttribute("contenteditable");
    const disabled =
      element.matches(":disabled") ||
      element.getAttribute("aria-disabled") === "true";
    const insideActions = Boolean(
      element.closest(".fai-BebopLiteChatInput__actions"),
    );
    const insideInput = Boolean(
      element.closest(".fai-BebopLiteChatInput, .fai-ChatInput"),
    );
    const insideCodeEditor = Boolean(
      element.closest(
        '[aria-label*="Code editor" i], .monaco-editor, .scriptor-component-code-block, [class*="code-block" i]',
      ),
    );

    return {
      path: elementPath(element),
      tag,
      id: element.id || null,
      classes: Array.from(element.classList),
      role: role || null,
      ariaLabel: ariaLabel || null,
      type: element.getAttribute("type"),
      testId: element.getAttribute("data-testid"),
      contentEditable,
      visible: isVisible(element),
      disabled,
      insideActions,
      insideInput,
      insideCodeEditor,
      textPreview: text.slice(0, 120),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  function validateMatch(group, description) {
    const reasons = [];

    if (!description.visible) reasons.push("hidden");
    if (description.insideCodeEditor) reasons.push("inside-code-editor");

    if (group === "editor") {
      const editorLike =
        description.contentEditable === "true" ||
        description.role === "textbox" ||
        description.tag === "textarea";
      if (!editorLike) reasons.push("not-editor-like");
      if (!description.insideInput) reasons.push("outside-chat-input");
    }

    if (group === "sendButton") {
      if (description.tag !== "button") reasons.push("not-button");
      if (!description.insideActions) reasons.push("outside-actions");
      if (/stop|dừng/i.test(description.ariaLabel || "")) {
        reasons.push("looks-like-stop");
      }
    }

    if (group === "stopButton") {
      const looksLikeStop =
        /stop|dừng/i.test(description.ariaLabel || "") ||
        description.testId === "stop-button" ||
        description.classes.some(name => /stopIcon/i.test(name));
      if (!looksLikeStop) reasons.push("does-not-look-like-stop");
    }

    if (group === "dictationButton") {
      if (!/dictation|voice|microphone|đọc chính tả/i.test(
        description.ariaLabel || "",
      )) {
        reasons.push("does-not-look-like-dictation");
      }
    }

    return {
      valid: reasons.length === 0,
      reasons,
    };
  }

  function inspectSelector(group, selector, index) {
    let elements = [];
    let syntaxError = null;
    try {
      elements = Array.from(document.querySelectorAll(selector));
    } catch (error) {
      syntaxError = error instanceof Error ? error.message : String(error);
    }

    const matches = elements.map(element => {
      const description = describeElement(element);
      return {
        ...description,
        validation: validateMatch(group, description),
      };
    });
    const visibleMatches = matches.filter(match => match.visible);
    const validVisibleMatches = visibleMatches.filter(
      match => match.validation.valid,
    );

    return {
      group,
      index,
      selector,
      syntaxError,
      totalMatches: matches.length,
      visibleMatches: visibleMatches.length,
      validVisibleMatches: validVisibleMatches.length,
      uniqueValidVisibleMatch: validVisibleMatches.length === 1,
      matches,
    };
  }

  function inferSurfaceState() {
    const stopVisible = SELECTOR_GROUPS.stopButton.some(selector => {
      try {
        return Array.from(document.querySelectorAll(selector)).some(isVisible);
      } catch {
        return false;
      }
    });
    const editorVisible = SELECTOR_GROUPS.editor.some(selector => {
      try {
        return Array.from(document.querySelectorAll(selector)).some(isVisible);
      } catch {
        return false;
      }
    });
    const sendVisible = SELECTOR_GROUPS.sendButton.some(selector => {
      try {
        return Array.from(document.querySelectorAll(selector)).some(isVisible);
      } catch {
        return false;
      }
    });

    if (stopVisible) return "generating";
    if (editorVisible && sendVisible) return "ready-to-send";
    if (editorVisible) return "idle-or-completed";
    return "unknown";
  }

  function snapshot(label = inferSurfaceState(), options = {}) {
    const { silent = false } = options;
    const selectors = Object.entries(SELECTOR_GROUPS).flatMap(
      ([group, values]) =>
        values.map((selector, index) =>
          inspectSelector(group, selector, index),
        ),
    );
    const result = {
      capturedAt: new Date().toISOString(),
      label,
      url: location.href,
      title: document.title,
      inferredSurfaceState: inferSurfaceState(),
      selectors,
    };
    state.snapshots.push(result);

    if (!silent) {
      const rows = selectors.map(item => ({
        group: item.group,
        index: item.index,
        selector: item.selector,
        total: item.totalMatches,
        visible: item.visibleMatches,
        validVisible: item.validVisibleMatches,
        unique: item.uniqueValidVisibleMatch,
        syntaxError: item.syntaxError || "",
      }));
      console.group(
        `[m365-selector-probe] ${label} @ ${result.capturedAt}`,
      );
      console.table(rows);
      console.log(
        "Chi tiết đầy đủ:",
        result,
      );
      console.groupEnd();
    }

    return result;
  }

  function summarizeSelector(group, selector, index) {
    const observations = state.snapshots
      .map(entry =>
        entry.selectors.find(
          item =>
            item.group === group &&
            item.index === index &&
            item.selector === selector,
        ),
      )
      .filter(Boolean);
    const observedStates = state.snapshots.map(entry => entry.label);
    const matchedSnapshots = observations.filter(
      item => item.totalMatches > 0,
    ).length;
    const validSnapshots = observations.filter(
      item => item.validVisibleMatches > 0,
    ).length;
    const uniqueSnapshots = observations.filter(
      item => item.uniqueValidVisibleMatch,
    ).length;
    const ambiguousSnapshots = observations.filter(
      item => item.validVisibleMatches > 1,
    ).length;
    const invalidVisibleSnapshots = observations.filter(item =>
      item.matches.some(
        match => match.visible && !match.validation.valid,
      ),
    ).length;

    let recommendation = "UNVERIFIED";
    if (observations.length > 0) {
      if (validSnapshots === 0) recommendation = "REMOVE_OR_RECHECK";
      else if (
        uniqueSnapshots === observations.length &&
        invalidVisibleSnapshots === 0
      ) {
        recommendation = "KEEP_PRIMARY";
      } else if (
        uniqueSnapshots > 0 &&
        ambiguousSnapshots === 0 &&
        invalidVisibleSnapshots === 0
      ) {
        recommendation = "KEEP_STATE_SPECIFIC";
      } else {
        recommendation = "TOO_BROAD_OR_AMBIGUOUS";
      }
    }

    return {
      group,
      index,
      selector,
      snapshots: observations.length,
      observedStates: [...new Set(observedStates)],
      matchedSnapshots,
      validSnapshots,
      uniqueSnapshots,
      ambiguousSnapshots,
      invalidVisibleSnapshots,
      recommendation,
    };
  }

  function recommend() {
    const result = Object.entries(SELECTOR_GROUPS).flatMap(
      ([group, selectors]) =>
        selectors.map((selector, index) =>
          summarizeSelector(group, selector, index),
        ),
    );
    console.group("[m365-selector-probe] Selector recommendations");
    console.table(result);
    console.log(
      "Chỉ xóa fallback sau khi đã chụp ít nhất idle, generating và completed.",
    );
    console.groupEnd();
    return result;
  }

  function report() {
    return {
      version: 1,
      startedAt: state.startedAt,
      generatedAt: new Date().toISOString(),
      location: {
        href: location.href,
        origin: location.origin,
        pathname: location.pathname,
      },
      selectorGroups: SELECTOR_GROUPS,
      snapshots: state.snapshots,
      mutations: state.mutations,
      recommendations: Object.entries(SELECTOR_GROUPS).flatMap(
        ([group, selectors]) =>
          selectors.map((selector, index) =>
            summarizeSelector(group, selector, index),
          ),
      ),
    };
  }

  async function copyReport() {
    const json = JSON.stringify(report(), null, 2);
    if (typeof copy === "function") {
      copy(json);
      console.log("[m365-selector-probe] Đã copy báo cáo bằng DevTools copy().");
      return json;
    }
    await navigator.clipboard.writeText(json);
    console.log("[m365-selector-probe] Đã copy báo cáo vào clipboard.");
    return json;
  }

  function start() {
    if (state.observer) return false;
    state.observer = new MutationObserver(mutations => {
      state.mutations.push({
        capturedAt: new Date().toISOString(),
        mutationCount: mutations.length,
        inferredSurfaceState: inferSurfaceState(),
      });
      clearTimeout(state.mutationTimer);
      state.mutationTimer = setTimeout(() => {
        snapshot(`mutation-${inferSurfaceState()}`, { silent: true });
      }, 250);
    });
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "aria-disabled",
        "class",
        "contenteditable",
        "data-testid",
        "disabled",
        "role",
        "type",
      ],
    });
    console.log(
      "[m365-selector-probe] Đang theo dõi DOM. Chạy m365SelectorProbe.stop() để dừng.",
    );
    return true;
  }

  function stop() {
    clearTimeout(state.mutationTimer);
    state.mutationTimer = null;
    if (!state.observer) return false;
    state.observer.disconnect();
    state.observer = null;
    console.log("[m365-selector-probe] Đã dừng theo dõi DOM.");
    return true;
  }

  const api = {
    selectors: SELECTOR_GROUPS,
    snapshot,
    start,
    stop,
    recommend,
    report,
    copyReport,
    reset() {
      state.snapshots.length = 0;
      state.mutations.length = 0;
      state.startedAt = new Date().toISOString();
      console.log("[m365-selector-probe] Đã xóa dữ liệu probe.");
    },
  };

  window[ROOT_KEY] = api;
  window.m365SelectorProbe = api;

  console.log(
    "[m365-selector-probe] Sẵn sàng. Bắt đầu bằng m365SelectorProbe.snapshot('idle').",
  );
})();
