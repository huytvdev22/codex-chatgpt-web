const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ALLOWED_ACTION_NAMES = new Set([
  "getUrl",
  "navigate",
  "waitForSelector",
  "clickSelector",
  "hoverSelector",
  "fillTextarea",
  "pressKey",
  "pasteImages",
  "aiStudioCheckCleanNewChat",
  "aiStudioCheckComposerIdle",
  "aiStudioSelectThinkingLevel",
  "aiStudioCheckSubmitStatus",
  "aiStudioWaitForBotGuardReady",
  "aiStudioCaptureBaseline",
  "aiStudioCaptureStatus",
  "aiStudioStopGeneration",
  "aiStudioCopyMarkdown",
  "aiStudioSpeechPrepareEditor",
  "aiStudioSpeechGetBaselineAudioSrc",
  "aiStudioSpeechConfigureSpeakers",
  "aiStudioSpeechConfigureTemperature",
  "aiStudioSpeechCaptureState",
  "aiStudioSpeechExtractAudio",
]);

function resolveClipboardMenuItemIndex(labels) {
  let textFallbackIndex = -1;
  for (let i = 0; i < labels.length; i += 1) {
    const normalized = (labels[i] || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) continue;
    if (/\bcopy as markdown\b/.test(normalized)) {
      return i;
    }
    if (textFallbackIndex < 0 && /\bcopy as text\b/.test(normalized)) {
      textFallbackIndex = i;
    }
  }
  return textFallbackIndex;
}

function normalizeCopiedAiStudioCodeSnippet(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  if (/^`{4}markdown\b/i.test(trimmed)) return trimmed;
  if (/^<webResponse\b/i.test(trimmed)) {
    return `\`\`\`\`markdown\n${trimmed}\n\`\`\`\``;
  }
  return trimmed;
}

function loadElectronApis(overrides = {}) {
  let electron = null;
  if (!overrides.clipboard || !overrides.nativeImage) {
    try {
      const mod = require("electron");
      if (mod && typeof mod === "object") electron = mod;
    } catch {
      electron = null;
    }
  }
  return {
    clipboard: overrides.clipboard || electron?.clipboard || null,
    nativeImage: overrides.nativeImage || electron?.nativeImage || null,
  };
}

function resolveProvider(host, providerId) {
  const id = providerId || host?.provider || "m365";
  if (host?.providerRegistry?.has?.(id)) {
    return host.providerRegistry.get(id);
  }
  if (typeof host?._resolveProvider === "function") {
    return host._resolveProvider(id);
  }
  return null;
}

/**
 * Thực thi các tác vụ điều khiển bề mặt trình duyệt (surface) thông qua API nội bộ
 * của Electron (`webContents.executeJavaScript`, `sendInputEvent`, `focus`, `loadURL`)
 * thay vì gắn Playwright CDP.
 */
class SurfaceActionExecutor {
  constructor(options = {}) {
    this.electronApis = loadElectronApis(options);
  }

  /**
   * Kiểm tra quyền sở hữu lượt theo `traceId` + `helperPid` rồi định tuyến tới action hợp lệ.
   */
  async execute(host, payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Surface action payload is invalid");
    }
    const { traceId, helperPid, action, args = {} } = payload;
    if (typeof action !== "string" || !ALLOWED_ACTION_NAMES.has(action)) {
      throw new Error(`Unsupported surface action: ${String(action)}`);
    }
    const { tab, contents } = this.resolveOwnedSurface(host, traceId, helperPid);
    tab.lastHeartbeatAt = Date.now();
    return await this[action](host, tab, contents, args && typeof args === "object" ? args : {});
  }

  resolveOwnedSurface(host, traceId, helperPid) {
    const tabs = host?.turnTabs instanceof Map ? [...host.turnTabs.values()] : [];
    const tab = tabs.find((candidate) => candidate.traceId === traceId);
    if (!tab) {
      const closedOwner = host?.closedTurnOwners instanceof Map
        ? host.closedTurnOwners.get(traceId)
        : undefined;
      if (closedOwner === helperPid) {
        throw new Error(`Browser turn ${traceId} was already released`);
      }
      throw new Error(`Browser turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.helperPid !== helperPid) {
      throw new Error(`Browser helper ownership mismatch: expected ${tab.helperPid}, received ${helperPid}`);
    }
    if (tab.status !== "running") {
      throw new Error(`Browser turn ${traceId} is no longer running`);
    }
    const contents = tab.view?.webContents;
    if (!contents || (typeof contents.isDestroyed === "function" && contents.isDestroyed())) {
      throw new Error(`Browser surface for turn ${traceId} is unavailable`);
    }
    return { tab, contents };
  }

  async execJs(contents, expression, userGesture = true) {
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) {
      throw new Error("Browser surface was destroyed during action");
    }
    return await contents.executeJavaScript(expression, userGesture);
  }

  focusSurface(contents) {
    if (typeof contents.focus === "function") {
      contents.focus();
    }
  }

  zoomFactor(contents) {
    if (typeof contents.getZoomFactor === "function") {
      const factor = contents.getZoomFactor();
      if (Number.isFinite(factor) && factor > 0) return factor;
    }
    return 1;
  }

  async sendMouseMove(contents, x, y) {
    if (typeof contents.sendInputEvent !== "function") return false;
    const zoom = this.zoomFactor(contents);
    const px = Math.max(1, Math.round(x * zoom));
    const py = Math.max(1, Math.round(y * zoom));
    contents.sendInputEvent({ type: "mouseMove", x: px, y: py });
    return true;
  }

  async sendTrustedClick(contents, x, y) {
    if (typeof contents.sendInputEvent !== "function") return false;
    this.focusSurface(contents);
    const zoom = this.zoomFactor(contents);
    const px = Math.max(1, Math.round(x * zoom));
    const py = Math.max(1, Math.round(y * zoom));
    contents.sendInputEvent({ type: "mouseMove", x: px, y: py });
    await sleep(15);
    contents.sendInputEvent({ type: "mouseDown", x: px, y: py, button: "left", clickCount: 1 });
    await sleep(20);
    contents.sendInputEvent({ type: "mouseUp", x: px, y: py, button: "left", clickCount: 1 });
    return true;
  }

  async sendKey(contents, key) {
    if (typeof contents.sendInputEvent === "function") {
      this.focusSurface(contents);
      const parts = String(key || "").split("+").map((p) => p.trim()).filter(Boolean);
      const modifiers = [];
      let keyCode = parts[parts.length - 1] || "Enter";
      for (let i = 0; i < parts.length - 1; i += 1) {
        const mod = parts[i].toLowerCase();
        if (mod === "meta" || mod === "command" || mod === "cmd") modifiers.push("meta");
        else if (mod === "control" || mod === "ctrl") modifiers.push("control");
        else if (mod === "shift") modifiers.push("shift");
        else if (mod === "alt" || mod === "option") modifiers.push("alt");
      }
      if (keyCode === "Enter") keyCode = "Return";
      contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      if (keyCode === "Return") {
        contents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
      }
      await sleep(15);
      contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      return true;
    }
    return false;
  }

  async queryElementCenter(contents, options) {
    const payload = JSON.stringify({
      selector: options.selector,
      nth: options.nth ?? 0,
      visibleOnly: options.visibleOnly !== false,
      allowZeroOpacity: options.allowZeroOpacity === true,
      textIncludes: options.textIncludes || "",
      containerSelector: options.containerSelector || "",
      containerNth: options.containerNth ?? 0,
      scrollBlock: options.scrollBlock || "center",
    });
    return await this.execJs(contents, `((opts) => {
      let root = document;
      if (opts.containerSelector) {
        const containers = Array.from(document.querySelectorAll(opts.containerSelector));
        const cIdx = opts.containerNth < 0 ? containers.length + opts.containerNth : opts.containerNth;
        root = containers[cIdx] || null;
      }
      if (!root) return { found: false };
      let candidates = Array.from(root.querySelectorAll(opts.selector));
      if (opts.visibleOnly) {
        candidates = candidates.filter((el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (!opts.allowZeroOpacity && style.opacity === "0") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      }
      if (opts.textIncludes) {
        const needle = opts.textIncludes.toLowerCase();
        candidates = candidates.filter((el) => (el.innerText || el.textContent || "").toLowerCase().includes(needle));
      }
      if (candidates.length === 0) return { found: false };
      const idx = opts.nth < 0 ? candidates.length + opts.nth : opts.nth;
      const target = candidates[idx];
      if (!target) return { found: false };
      target.scrollIntoView?.({ block: opts.scrollBlock, inline: "center" });
      const rect = target.getBoundingClientRect();
      const vw = Math.max(1, window.innerWidth || 800);
      const vh = Math.max(1, window.innerHeight || 600);
      const x = Math.min(vw - 2, Math.max(2, rect.left + rect.width / 2));
      const y = Math.min(vh - 2, Math.max(2, rect.top + rect.height / 2));
      const disabled = Boolean(target.disabled || target.getAttribute("aria-disabled") === "true");
      return {
        found: true,
        x,
        y,
        disabled,
        text: (target.innerText || target.textContent || "").trim(),
      };
    })(${payload})`);
  }

  async clickLocatedElement(contents, queryOptions, fallbackDomClick = true) {
    const info = await this.queryElementCenter(contents, queryOptions);
    if (!info || !info.found) return { clicked: false, info: null };
    if (queryOptions.trusted !== false && typeof contents.sendInputEvent === "function") {
      await this.sendTrustedClick(contents, info.x, info.y);
      return { clicked: true, info };
    }
    if (fallbackDomClick) {
      const payload = JSON.stringify({
        selector: queryOptions.selector,
        nth: queryOptions.nth ?? 0,
        visibleOnly: queryOptions.visibleOnly !== false,
        textIncludes: queryOptions.textIncludes || "",
        containerSelector: queryOptions.containerSelector || "",
        containerNth: queryOptions.containerNth ?? 0,
      });
      await this.execJs(contents, `((opts) => {
        let root = document;
        if (opts.containerSelector) {
          const containers = Array.from(document.querySelectorAll(opts.containerSelector));
          const cIdx = opts.containerNth < 0 ? containers.length + opts.containerNth : opts.containerNth;
          root = containers[cIdx] || null;
        }
        if (!root) return false;
        let candidates = Array.from(root.querySelectorAll(opts.selector));
        if (opts.visibleOnly) {
          candidates = candidates.filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
        }
        if (opts.textIncludes) {
          const needle = opts.textIncludes.toLowerCase();
          candidates = candidates.filter((el) => (el.innerText || el.textContent || "").toLowerCase().includes(needle));
        }
        const idx = opts.nth < 0 ? candidates.length + opts.nth : opts.nth;
        const target = candidates[idx];
        if (!target) return false;
        target.scrollIntoView?.({ block: "center", inline: "center" });
        target.click();
        return true;
      })(${payload})`);
      return { clicked: true, info };
    }
    return { clicked: false, info };
  }

  // ---------- Basic Surface Actions ----------

  async getUrl(_host, _tab, contents) {
    return { url: typeof contents.getURL === "function" ? contents.getURL() : "" };
  }

  async navigate(host, tab, contents, args) {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) throw new Error("navigate requires a non-empty url");
    const providerObj = resolveProvider(host, tab.provider);
    if (providerObj && typeof providerObj.isAllowedNavigation === "function" && !providerObj.isAllowedNavigation(url)) {
      throw new Error(`Navigation to ${url} is not allowed for provider ${tab.provider}`);
    }
    if (typeof contents.loadURL !== "function") {
      throw new Error("Browser surface does not support loadURL");
    }
    const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 25_000;
    let timer = null;
    try {
      await Promise.race([
        contents.loadURL(url),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Navigation to ${url} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      // Electron throws ERR_ABORTED (-3) if SPA replaces route immediately during load; keep if already on target origin
      const current = typeof contents.getURL === "function" ? contents.getURL() : "";
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_ABORTED") || !current.startsWith("https://aistudio.google.com")) {
        throw error;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { url: typeof contents.getURL === "function" ? contents.getURL() : url };
  }

  async waitForSelector(_host, _tab, contents, args) {
    const selector = typeof args.selector === "string" ? args.selector : "";
    if (!selector) throw new Error("waitForSelector requires selector");
    const visible = args.visible !== false;
    const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 15_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const matched = await this.execJs(contents, `((sel, checkVisible) => {
        const nodes = Array.from(document.querySelectorAll(sel));
        if (nodes.length === 0) return false;
        if (!checkVisible) return true;
        return nodes.some((el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      })(${JSON.stringify(selector)}, ${JSON.stringify(visible)})`).catch(() => false);
      if (matched) return { found: true };
      await sleep(150);
    }
    throw new Error(`Timed out waiting ${timeoutMs}ms for selector: ${selector}`);
  }

  async clickSelector(_host, _tab, contents, args) {
    const selector = typeof args.selector === "string" ? args.selector : "";
    if (!selector) throw new Error("clickSelector requires selector");
    const result = await this.clickLocatedElement(contents, args, true);
    if (!result.clicked) {
      throw new Error(`Element not found for clickSelector: ${selector}`);
    }
    return { clicked: true, ...result.info };
  }

  async hoverSelector(_host, _tab, contents, args) {
    const info = await this.queryElementCenter(contents, args);
    if (!info || !info.found) return { hovered: false };
    await this.sendMouseMove(contents, info.x, info.y);
    return { hovered: true };
  }

  async fillTextarea(_host, _tab, contents, args) {
    const selector = typeof args.selector === "string" ? args.selector : "";
    if (!selector) throw new Error("fillTextarea requires selector");
    const value = typeof args.value === "string" ? args.value : "";

    const info = await this.queryElementCenter(contents, { selector, nth: args.nth ?? 0, visibleOnly: true });
    if (!info || !info.found) {
      if (args.optional) return { ok: false, skipped: true, length: 0 };
      throw new Error(`Input not found for fillTextarea: ${selector}`);
    }
    await this.sendTrustedClick(contents, info.x, info.y);
    await sleep(30);

    const payload = JSON.stringify({ selector, nth: args.nth ?? 0, value, blur: args.blur === true });
    const filled = await this.execJs(contents, `((opts) => {
      const nodes = Array.from(document.querySelectorAll(opts.selector)).filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const el = nodes[opts.nth] || document.querySelector(opts.selector);
      if (!el) return { ok: false, length: 0 };
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, opts.value);
      else el.value = opts.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (opts.blur) el.blur();
      return { ok: true, length: (el.value || "").length };
    })(${payload})`);

    if (args.pressEnter) {
      await this.sendKey(contents, "Enter");
    }
    return filled;
  }

  async pressKey(_host, _tab, contents, args) {
    const key = typeof args.key === "string" ? args.key : "";
    if (!key) throw new Error("pressKey requires key");
    const sent = await this.sendKey(contents, key);
    return { sent };
  }

  async pasteImages(_host, _tab, contents, args) {
    const files = Array.isArray(args.files) ? args.files.slice(0, 3) : [];
    const targetSelector = typeof args.targetSelector === "string"
      ? args.targetSelector
      : 'textarea[aria-label="Enter a prompt"]';
    if (files.length === 0) return { attachedCount: 0 };

    const info = await this.queryElementCenter(contents, { selector: targetSelector, visibleOnly: true });
    if (!info || !info.found) {
      throw new Error(`Target composer not found for pasteImages: ${targetSelector}`);
    }
    await this.sendTrustedClick(contents, info.x, info.y);
    await sleep(50);

    let attachedCount = 0;
    const { clipboard, nativeImage } = this.electronApis;

    for (const file of files) {
      const name = typeof file.name === "string" && file.name ? file.name : "image.png";
      const mimeType = typeof file.mimeType === "string" && file.mimeType ? file.mimeType : "image/png";
      const dataBase64 = typeof file.dataBase64 === "string" ? file.dataBase64 : "";
      if (!dataBase64) continue;

      // Ưu tiên DataTransfer + ClipboardEvent('paste') để không chạm clipboard hệ thống của người dùng.
      const eventConsumed = await this.execJs(contents, `((opts) => {
        const target = document.querySelector(opts.selector);
        if (!target) return false;
        target.focus();
        const raw = atob(opts.dataBase64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], opts.name, { type: opts.mimeType }));
        const ev = new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        });
        const notCancelled = target.dispatchEvent(ev);
        return ev.defaultPrevented || !notCancelled;
      })(${JSON.stringify({ selector: targetSelector, name, mimeType, dataBase64 })})`).catch(() => false);

      if (eventConsumed) {
        attachedCount += 1;
        await sleep(250);
        continue;
      }

      // Fallback sang native clipboard image + contents.paste() (cần Electron clipboard APIs).
      if (clipboard && nativeImage && typeof contents.paste === "function") {
        const previousText = clipboard.readText();
        const previousImage = clipboard.readImage();
        try {
          const img = nativeImage.createFromBuffer(Buffer.from(dataBase64, "base64"));
          if (!img.isEmpty()) {
            this.focusSurface(contents);
            clipboard.writeImage(img);
            contents.paste();
            attachedCount += 1;
            await sleep(350);
          }
        } finally {
          if (previousImage && !previousImage.isEmpty()) clipboard.writeImage(previousImage);
          else if (previousText) clipboard.writeText(previousText);
          else clipboard.clear();
        }
      }
    }

    if (attachedCount > 0) await sleep(300);
    return { attachedCount };
  }

  // ---------- AI Studio Chat Actions ----------

  async aiStudioCheckCleanNewChat(_host, _tab, contents, args) {
    const targetModel = typeof args.targetModel === "string" ? args.targetModel : "";
    const clean = await this.execJs(contents, `((modelName) => {
      const turns = document.querySelectorAll(".chat-session-content ms-chat-turn, .chat-session-content .chat-turn-container");
      if (turns.length > 0) return false;
      const urlModel = new URLSearchParams(location.search).get("model") || "";
      if (urlModel.toLowerCase() === modelName.toLowerCase()) return true;
      const panelText = (document.querySelector(".run-settings-panel, ms-run-settings")?.textContent || "").toLowerCase();
      return panelText.includes(modelName.toLowerCase());
    })(${JSON.stringify(targetModel)})`).catch(() => false);
    return { clean: Boolean(clean) };
  }

  async aiStudioCheckComposerIdle(_host, _tab, contents, args) {
    const selector = typeof args.selector === "string"
      ? args.selector
      : 'ms-prompt-run-button button, button.ctrl-enter-submits';
    const label = await this.execJs(contents, `((sel) => {
      const btn = document.querySelector(sel);
      if (!btn) return "";
      return (btn.innerText || btn.getAttribute("aria-label") || "").trim().toLowerCase();
    })(${JSON.stringify(selector)})`).catch(() => "");
    return {
      idle: !label.includes("stop") && !label.includes("cancel"),
      label,
    };
  }

  async aiStudioSelectThinkingLevel(_host, _tab, contents, args) {
    const targetLevel = typeof args.targetLevel === "string" ? args.targetLevel : "";
    if (!targetLevel) return { changed: false };
    const selectSelector = 'mat-select[role="combobox"][aria-label="Thinking Level"], #mat-select-0[aria-label="Thinking Level"]';
    const optionSelector = '.mat-mdc-select-panel [role="option"], [role="listbox"] [role="option"]';

    const selectInfo = await this.queryElementCenter(contents, { selector: selectSelector, visibleOnly: true });
    if (!selectInfo || !selectInfo.found) return { changed: false, skipped: "not_visible" };

    const currentText = (selectInfo.text || "").toLowerCase();
    const currentFirstLine = currentText.split(/\r?\n/)[0]?.trim() || "";
    if (currentText === targetLevel.toLowerCase() || currentFirstLine === targetLevel.toLowerCase()) {
      return { changed: false };
    }

    await this.sendTrustedClick(contents, selectInfo.x, selectInfo.y);
    const deadline = Date.now() + 3_000;
    let optionsFound = false;
    while (Date.now() < deadline) {
      const count = await this.execJs(contents, `((sel) => document.querySelectorAll(sel).length)(${JSON.stringify(optionSelector)})`).catch(() => 0);
      if (count > 0) {
        optionsFound = true;
        break;
      }
      await sleep(100);
    }
    if (!optionsFound) return { changed: false };

    const optionClick = await this.clickLocatedElement(contents, {
      selector: optionSelector,
      textIncludes: targetLevel,
      visibleOnly: true,
    });
    if (optionClick.clicked) {
      await sleep(150);
      return { changed: true };
    }
    await this.sendKey(contents, "Escape");
    return { changed: false };
  }

  async aiStudioCheckSubmitStatus(_host, _tab, contents, args) {
    return await this.execJs(contents, `((opts) => {
      const btn = document.querySelector(opts.btnSelector);
      const btnText = (btn?.innerText || btn?.getAttribute("aria-label") || "").trim().toLowerCase();
      const isDisabled = Boolean(btn?.disabled || btn?.getAttribute("aria-disabled") === "true");
      const liveText = Array.from(document.querySelectorAll(opts.liveSelector))
        .map((el) => (el.innerText || "").trim())
        .join(" ");
      const editor = document.querySelector(opts.composerSelector);
      return {
        isStop: btnText.includes("stop") || btnText.includes("cancel"),
        isRunningLive: /running/i.test(liveText),
        isDisabled,
        editorLength: (editor?.value || "").trim().length,
      };
    })(${JSON.stringify(args)})`);
  }

  async aiStudioWaitForBotGuardReady(_host, _tab, contents, args) {
    const minPageAgeMs = Number.isFinite(args.minPageAgeMs) ? Math.max(0, args.minPageAgeMs) : 1_200;
    const maxWaitMs = Number.isFinite(args.maxWaitMs) ? Math.max(0, args.maxWaitMs) : 1_500;
    const startedAt = Date.now();

    while (true) {
      const probe = await this.execJs(contents, `(() => {
        const resources = performance.getEntriesByType("resource") || [];
        const waaReady = resources.some((entry) => {
          const name = String(entry?.name || "");
          return (/waa-pa\\.clients6\\.google\\.com|google\\.com\\/js\\/th/i.test(name))
            && (!Number.isFinite(entry?.responseEnd) || entry.responseEnd > 0);
        });
        return {
          waaReady,
          pageAgeMs: performance.now(),
        };
      })()`).catch(() => ({ waaReady: false, pageAgeMs: 0 }));

      const elapsedMs = Date.now() - startedAt;
      if ((probe.waaReady && probe.pageAgeMs >= minPageAgeMs) || elapsedMs >= maxWaitMs) {
        return {
          settled: true,
          waaReady: Boolean(probe.waaReady),
          pageAgeMs: Math.round(probe.pageAgeMs || 0),
          elapsedMs,
        };
      }
      await sleep(Math.min(150, Math.max(20, maxWaitMs - elapsedMs)));
    }
  }

  async aiStudioCaptureBaseline(_host, _tab, contents, args) {
    return await this.execJs(contents, `((opts) => {
      const containers = Array.from(document.querySelectorAll(opts.containerSelector));
      const thoughts = containers.filter((el) => Boolean(el.querySelector(opts.thoughtSelector)));
      const answers = containers.filter((el) => !el.querySelector(opts.thoughtSelector));
      const lastAnswer = answers[answers.length - 1];
      return {
        modelContainerCount: containers.length,
        answerCount: answers.length,
        thoughtsCount: thoughts.length,
        lastAnswerText: lastAnswer ? (lastAnswer.innerText || "").trim() : "",
      };
    })(${JSON.stringify(args)})`);
  }

  async aiStudioCaptureStatus(_host, _tab, contents, args) {
    return await this.execJs(contents, `((opts) => {
      const selectors = opts.selectors;
      const actionBtn = document.querySelector(selectors.runOrStopButton);
      const stopBtn =
        actionBtn ||
        document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Cancel generation" i]');
      const btnText = (
        stopBtn?.innerText ||
        stopBtn?.getAttribute("aria-label") ||
        stopBtn?.getAttribute("mattooltip") ||
        ""
      ).trim().toLowerCase();
      const liveText = Array.from(document.querySelectorAll(selectors.liveStatus))
        .map((el) => (el.innerText || el.textContent || "").trim())
        .join(" ");
      const isLiveRunning = /running/i.test(liveText);
      const isResponseReadyLive = /response ready/i.test(liveText);
      const isStopVisible = btnText.includes("stop") || btnText.includes("cancel");
      const isGenerating = isStopVisible || isLiveRunning;

      let detectedWebError = "";
      const alertErrorRegex = /Failed to generate content|permission denied|quota exceeded|rate limit|service unavailable/i;
      for (const alertEl of document.querySelectorAll(
        '[role="alert"], mat-snack-bar-container, simple-snack-bar, [class*="error-banner" i], [class*="toast" i]',
      )) {
        const text = (alertEl.innerText || alertEl.textContent || "").trim();
        if (text && alertErrorRegex.test(text)) {
          detectedWebError = text.replace(/\\s+/g, " ").slice(0, 300);
          break;
        }
      }

      const allContainers = Array.from(document.querySelectorAll(selectors.modelTurnContainer));
      const thoughtsCount = allContainers.filter((el) => Boolean(el.querySelector(selectors.thoughtPanel))).length;
      const answerContainers = allContainers.filter((el) => !el.querySelector(selectors.thoughtPanel));

      const freshAnswers = answerContainers.slice(opts.baselineAnswerCount || 0);
      const targetAnswer = freshAnswers[freshAnswers.length - 1];
      if (!targetAnswer) {
        return {
          isGenerating,
          responseReadyLive: isResponseReadyLive,
          hasNewAnswerTurn: false,
          hasTurnFooter: false,
          thoughtsCount,
          rawHtml: "",
          rawText: "",
          singleMarkdownCodeBlockText: null,
          hasContent: false,
          detectedWebError,
        };
      }

      const hasTurnFooter = Boolean(targetAnswer.querySelector(selectors.turnFooter));
      const clone = targetAnswer.cloneNode(true);
      for (const noise of clone.querySelectorAll(
        [
          "h3.author-label",
          ".actions",
          ".turn-footer",
          "mat-accordion",
          "mat-expansion-panel.thought-panel",
          "ms-code-block mat-expansion-panel-header",
          ".code-block-header",
          "[class*='code-block-decoration' i]",
        ].join(", "),
      )) {
        noise.remove();
      }

      let singleMarkdownCodeBlockText = null;
      const originalCodeBlocks = Array.from(targetAnswer.querySelectorAll("ms-code-block"));
      if (originalCodeBlocks.length === 1) {
        const origBlock = originalCodeBlocks[0];
        const headerLabel = (
          origBlock.querySelector("mat-expansion-panel-header, .code-block-header")?.textContent || ""
        ).trim().toLowerCase();
        const isMarkdownLang = headerLabel.includes("markdown") || /\\bmd\\b/.test(headerLabel);
        const clonePre = clone.querySelector("ms-code-block pre code, pre code");
        const cloneOutsideText = (() => {
          const checkClone = clone.cloneNode(true);
          for (const el of checkClone.querySelectorAll("ms-code-block")) el.remove();
          return (checkClone.innerText || checkClone.textContent || "").trim();
        })();
        if (!cloneOutsideText && clonePre) {
          const extracted = (clonePre.textContent || "").trim();
          if (extracted && (isMarkdownLang || /^<webResponse\\b/i.test(extracted))) {
            singleMarkdownCodeBlockText = extracted;
          }
        }
      }

      const rawHtml = clone.innerHTML.trim();
      const rawText = (clone.innerText || clone.textContent || "").trim();
      if (
        !detectedWebError &&
        !hasTurnFooter &&
        /^(?:Permission denied\\.|Failed to generate content\\b|An internal error has occurred\\.|Quota exceeded\\b|Please check your account permissions)/i.test(
          rawText,
        )
      ) {
        detectedWebError = rawText.replace(/\\s+/g, " ").slice(0, 300);
      }

      return {
        isGenerating,
        responseReadyLive: isResponseReadyLive,
        hasNewAnswerTurn: true,
        hasTurnFooter,
        thoughtsCount,
        rawHtml,
        rawText,
        singleMarkdownCodeBlockText,
        hasContent: rawText.length > 0 || Boolean(singleMarkdownCodeBlockText),
        detectedWebError,
      };
    })(${JSON.stringify(args)})`);
  }

  async aiStudioStopGeneration(_host, _tab, contents, args) {
    const selector = typeof args.selector === "string"
      ? args.selector
      : 'ms-prompt-run-button button, button.ctrl-enter-submits';
    const info = await this.queryElementCenter(contents, { selector, visibleOnly: true });
    if (!info || !info.found) return { stopped: false };
    const label = (info.text || "").toLowerCase();
    if (!label.includes("stop") && !label.includes("cancel")) return { stopped: false };
    await this.sendTrustedClick(contents, info.x, info.y);
    return { stopped: true };
  }

  async aiStudioCopyMarkdown(_host, _tab, contents, args) {
    const baselineAnswerCount = Number(args.baselineAnswerCount) || 0;
    const modelTurnContainer = args.modelTurnContainer || ".chat-session-content .chat-turn-container.model";
    const thoughtPanel = args.thoughtPanel || "mat-expansion-panel.thought-panel";
    const answerTurnSelector = `${modelTurnContainer}:not(:has(${thoughtPanel}))`;
    const openOptionsSelector = 'button[aria-label="Open options"]';
    const codeCopySelector = 'ms-code-block button[aria-label="Copy code to clipboard"]';

    const { clipboard } = this.electronApis;
    const previousSystemClipboard = clipboard ? clipboard.readText() : "";
    let touchedSystemClipboard = false;

    try {
      await this.execJs(contents, `(() => {
        window.__aistudio_last_copied_markdown = null;
        if (!window.__aistudio_clipboard_hooked) {
          window.__aistudio_clipboard_hooked = true;
          if (navigator.clipboard) {
            const origWriteText = navigator.clipboard.writeText?.bind(navigator.clipboard);
            navigator.clipboard.writeText = async (text) => {
              window.__aistudio_last_copied_markdown = text;
              if (!origWriteText) return;
              try { await origWriteText(text); } catch {}
            };
            const origWrite = navigator.clipboard.write?.bind(navigator.clipboard);
            if (origWrite) {
              navigator.clipboard.write = async (items) => {
                try {
                  for (const item of items) {
                    if (item.types.includes("text/plain")) {
                      const blob = await item.getType("text/plain");
                      const text = await blob.text();
                      if (text) window.__aistudio_last_copied_markdown = text;
                      break;
                    }
                  }
                } catch {}
                try { await origWrite(items); } catch {}
              };
            }
          }
          document.addEventListener("copy", (event) => {
            const clipText = event.clipboardData?.getData("text/plain");
            const activeEl = document.activeElement;
            const activeValue = activeEl && (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT")
              ? activeEl.value
              : "";
            const selected = window.getSelection()?.toString() || "";
            const captured = clipText || selected || activeValue;
            if (captured) window.__aistudio_last_copied_markdown = captured;
          }, { capture: true });
        }
      })()`);

      const turnCount = await this.execJs(contents, `((sel) => document.querySelectorAll(sel).length)(${JSON.stringify(answerTurnSelector)})`);
      if (turnCount <= baselineAnswerCount) {
        return { text: null };
      }
      const turnIndex = turnCount - 1;
      const turnInfo = await this.queryElementCenter(contents, {
        selector: answerTurnSelector,
        nth: turnIndex,
        visibleOnly: false,
      });
      if (turnInfo && turnInfo.found) {
        await this.sendMouseMove(contents, turnInfo.x, turnInfo.y);
        await sleep(80);
      }

      const pollCapturedClipboard = async () => {
        const deadline = Date.now() + 1_500;
        while (Date.now() < deadline) {
          await sleep(100);
          const jsCopied = await this.execJs(contents, `(() => {
            const val = window.__aistudio_last_copied_markdown;
            return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
          })()`).catch(() => null);
          if (jsCopied) return jsCopied;
          if (clipboard) {
            const sysText = clipboard.readText();
            if (sysText && sysText.trim() && sysText !== previousSystemClipboard) {
              touchedSystemClipboard = true;
              return sysText.trim();
            }
          }
        }
        return null;
      };

      // Thử mở Open options menu
      const menuOpenCount = await this.execJs(contents, `document.querySelectorAll('div.mat-mdc-menu-panel[role="menu"]').length`).catch(() => 0);
      if (menuOpenCount > 0) {
        await this.sendKey(contents, "Escape");
        await sleep(80);
      }

      const optionsClicked = await this.clickLocatedElement(contents, {
        selector: openOptionsSelector,
        containerSelector: answerTurnSelector,
        containerNth: turnIndex,
        visibleOnly: true,
        allowZeroOpacity: true,
      });

      if (optionsClicked.clicked) {
        let menuReady = false;
        const menuDeadline = Date.now() + 2_000;
        while (Date.now() < menuDeadline) {
          const itemCount = await this.execJs(contents, `(() => {
            const panels = document.querySelectorAll('div.mat-mdc-menu-panel[role="menu"]');
            const panel = panels[panels.length - 1];
            return panel ? panel.querySelectorAll('button.mat-mdc-menu-item').length : 0;
          })()`).catch(() => 0);
          if (itemCount > 0) {
            menuReady = true;
            break;
          }
          await sleep(60);
        }

        if (menuReady) {
          const labels = await this.execJs(contents, `(() => {
            const panels = document.querySelectorAll('div.mat-mdc-menu-panel[role="menu"]');
            const panel = panels[panels.length - 1];
            if (!panel) return [];
            return Array.from(panel.querySelectorAll('button.mat-mdc-menu-item')).map((el) =>
              (el.innerText || el.getAttribute("aria-label") || "").trim()
            );
          })()`).catch(() => []);
          const chosenIndex = resolveClipboardMenuItemIndex(labels);
          if (chosenIndex >= 0) {
            await this.clickLocatedElement(contents, {
              containerSelector: 'div.mat-mdc-menu-panel[role="menu"]',
              containerNth: -1,
              selector: 'button.mat-mdc-menu-item',
              nth: chosenIndex,
              visibleOnly: true,
            });
            const copied = await pollCapturedClipboard();
            if (copied) return { text: copied };
          } else {
            await this.sendKey(contents, "Escape");
          }
        }
      }

      // Fallback single ms-code-block copy button
      const codeBlocksCount = await this.execJs(contents, `((sel, idx) => {
        const turn = document.querySelectorAll(sel)[idx];
        return turn ? turn.querySelectorAll("ms-code-block").length : 0;
      })(${JSON.stringify(answerTurnSelector)}, ${turnIndex})`).catch(() => 0);

      if (codeBlocksCount === 1) {
        const codeClick = await this.clickLocatedElement(contents, {
          selector: codeCopySelector,
          containerSelector: answerTurnSelector,
          containerNth: turnIndex,
          visibleOnly: true,
        });
        if (codeClick.clicked) {
          const copiedCode = await pollCapturedClipboard();
          if (copiedCode) {
            return { text: normalizeCopiedAiStudioCodeSnippet(copiedCode) };
          }
        }
      }

      return { text: null };
    } catch {
      await this.sendKey(contents, "Escape").catch(() => {});
      return { text: null };
    } finally {
      if (clipboard && touchedSystemClipboard) {
        if (previousSystemClipboard) clipboard.writeText(previousSystemClipboard);
        else clipboard.clear();
      }
    }
  }

  // ---------- AI Studio Speech Actions ----------

  async aiStudioSpeechPrepareEditor(_host, _tab, contents, args) {
    const promptSelector = args.promptSelector || 'textarea[aria-label="Enter a prompt"]';
    const textToggleSelector = args.textToggleSelector
      || 'button.toggle-button[data-value="TEXT"], button[role="radio"][data-value="TEXT"]';
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      const state = await this.execJs(contents, `((pSel, tSel) => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const promptVisible = Array.from(document.querySelectorAll(pSel)).some(isVisible);
        const toggleEl = Array.from(document.querySelectorAll(tSel)).find(isVisible);
        const presetEl = Array.from(document.querySelectorAll('button, [role="button"]'))
          .find((el) => isVisible(el) && (el.innerText || el.textContent || "").includes("The Energetic Co-Host"));
        if (presetEl && !promptVisible && !toggleEl) {
          presetEl.scrollIntoView?.({ block: "center", inline: "center" });
          const rect = presetEl.getBoundingClientRect();
          return { promptVisible, toggleVisible: false, presetRect: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
        }
        return { promptVisible, toggleVisible: Boolean(toggleEl), presetRect: null };
      })(${JSON.stringify(promptSelector)}, ${JSON.stringify(textToggleSelector)})`);

      if (state.promptVisible || state.toggleVisible) break;
      if (state.presetRect) {
        await this.sendTrustedClick(contents, state.presetRect.x, state.presetRect.y);
        await sleep(300);
        continue;
      }
      await sleep(200);
    }

    // Ensure Text mode
    const toggleDeadline = Date.now() + 8_000;
    while (Date.now() < toggleDeadline) {
      const modeState = await this.execJs(contents, `((pSel, tSel) => {
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const promptVisible = Array.from(document.querySelectorAll(pSel)).some(isVisible);
        if (promptVisible) return { done: true };
        const toggleEl = Array.from(document.querySelectorAll(tSel)).find(isVisible)
          || Array.from(document.querySelectorAll('button.toggle-button')).find((el) => isVisible(el) && (el.innerText || "").includes("Text"));
        if (!toggleEl) return { done: false, toggleRect: null };
        if (toggleEl.getAttribute("aria-checked") === "true") return { done: true };
        toggleEl.scrollIntoView?.({ block: "center", inline: "center" });
        const rect = toggleEl.getBoundingClientRect();
        return { done: false, toggleRect: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
      })(${JSON.stringify(promptSelector)}, ${JSON.stringify(textToggleSelector)})`);

      if (modeState.done) break;
      if (modeState.toggleRect) {
        await this.sendTrustedClick(contents, modeState.toggleRect.x, modeState.toggleRect.y);
      }
      await sleep(200);
    }

    await this.waitForSelector(null, null, contents, { selector: promptSelector, timeoutMs: 15_000 });
    return { ready: true };
  }

  async aiStudioSpeechGetBaselineAudioSrc(_host, _tab, contents) {
    const audioSrc = await this.execJs(contents, `document.querySelector("audio")?.getAttribute("src") || ""`).catch(() => "");
    return { audioSrc };
  }

  async aiStudioSpeechConfigureTemperature(_host, _tab, contents, args) {
    const temperature = Number(args.temperature);
    if (!Number.isFinite(temperature)) return { updated: false };
    const inputSelector = 'input.slider-number-input[role="spinbutton"]';
    const toggleSelector = 'button[aria-label="Expand or collapse Model settings"]';

    const inputInfo = await this.queryElementCenter(contents, { selector: inputSelector, visibleOnly: true });
    if (!inputInfo || !inputInfo.found) {
      await this.clickLocatedElement(contents, { selector: toggleSelector, visibleOnly: true }).catch(() => {});
      await sleep(250);
    }

    const readyInput = await this.queryElementCenter(contents, { selector: inputSelector, visibleOnly: true });
    if (!readyInput || !readyInput.found) return { updated: false };

    const formatted = String(Math.max(0, Math.min(2, temperature)));
    const current = await this.execJs(contents, `((sel) => (document.querySelector(sel)?.value || "").trim())(${JSON.stringify(inputSelector)})`).catch(() => "");
    if (current === formatted) return { updated: false };

    await this.fillTextarea(null, null, contents, {
      selector: inputSelector,
      value: formatted,
      blur: true,
      pressEnter: true,
    });
    await sleep(150);
    return { updated: true };
  }

  async aiStudioSpeechConfigureSpeakers(_host, _tab, contents, args) {
    const orderedSpeakers = Array.isArray(args.orderedSpeakers) ? args.orderedSpeakers : [];
    const audioProfiles = args.audioProfiles || {};
    const directorNotes = args.directorNotes || {};
    if (orderedSpeakers.length === 0) return { configured: 0 };

    const voiceCardSelector = ".active-voice-card";
    const aliasInputSelector = 'input.speaker-alias-input[aria-label="Speaker name"]';
    const aliasTagSelector = ".speaker-alias-tag";
    const cardTriggerSelector = "button.active-voice-card-trigger";
    const availableVoicesSelector = '[aria-label="Available voices"]';
    const voicePersonaSelector = 'textarea[aria-label*="voice persona" i]';
    const closeDrawerSelector = 'button[aria-label="Close panel"]';

    const cardCount = await this.execJs(contents, `document.querySelectorAll(${JSON.stringify(voiceCardSelector)}).length`).catch(() => 0);
    if (cardCount === 0) return { configured: 0 };

    const currentAliases = await this.execJs(contents, `((cardSel, inputSel, tagSel) => {
      return Array.from(document.querySelectorAll(cardSel)).map((card) => {
        const inputVal = card.querySelector(inputSel)?.value || "";
        const tagText = card.querySelector(tagSel)?.textContent || "";
        return (inputVal || tagText).trim().toLowerCase();
      });
    })(${JSON.stringify(voiceCardSelector)}, ${JSON.stringify(aliasInputSelector)}, ${JSON.stringify(aliasTagSelector)})`);

    const setCardAlias = async (cardIndex, aliasValue) => {
      const clicked = await this.clickLocatedElement(contents, {
        selector: aliasInputSelector,
        containerSelector: voiceCardSelector,
        containerNth: cardIndex,
        visibleOnly: true,
      });
      if (!clicked.clicked) return;
      await this.execJs(contents, `((cardSel, idx, inputSel, val) => {
        const card = document.querySelectorAll(cardSel)[idx];
        const el = card?.querySelector(inputSel);
        if (!el) return;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.blur();
      })(${JSON.stringify(voiceCardSelector)}, ${cardIndex}, ${JSON.stringify(aliasInputSelector)}, ${JSON.stringify(aliasValue)})`);
      await this.sendKey(contents, "Enter");
    };

    const pairCount = Math.min(cardCount, orderedSpeakers.length);
    for (let i = 0; i < pairCount; i += 1) {
      const speakerConfig = orderedSpeakers[i];
      const targetName = String(speakerConfig.speaker || "").trim();
      const targetLower = targetName.toLowerCase();

      if (currentAliases[i] !== targetLower) {
        for (let j = i + 1; j < cardCount; j += 1) {
          if (currentAliases[j] === targetLower) {
            const tmpAlias = `__speaker_tmp_${j}__`;
            await setCardAlias(j, tmpAlias);
            currentAliases[j] = tmpAlias;
          }
        }
        await setCardAlias(i, targetName);
        currentAliases[i] = targetLower;
      }

      const triggerClick = await this.clickLocatedElement(contents, {
        selector: cardTriggerSelector,
        containerSelector: voiceCardSelector,
        containerNth: i,
        visibleOnly: true,
      });
      if (!triggerClick.clicked) {
        throw new Error(`Could not open voice drawer for speaker card ${i}`);
      }
      await this.waitForSelector(null, null, contents, { selector: availableVoicesSelector, timeoutMs: 5_000 });

      const profileText = audioProfiles[targetLower];
      if (profileText !== undefined) {
        const personaVisible = await this.queryElementCenter(contents, { selector: voicePersonaSelector, visibleOnly: true });
        if (personaVisible.found) {
          await this.fillTextarea(null, null, contents, { selector: voicePersonaSelector, value: profileText });
        }
      }

      const directorNote = directorNotes[targetLower];
      if (directorNote) {
        for (const [buttonLabel, targetValue] of [
          ["Style", directorNote.style],
          ["Pace", directorNote.pace],
          ["Accent", directorNote.accent],
        ]) {
          if (!targetValue) continue;
          const btnClick = await this.clickLocatedElement(contents, {
            selector: "button",
            textIncludes: buttonLabel,
            visibleOnly: true,
          });
          if (!btnClick.clicked) continue;
          await sleep(150);
          const itemClick = await this.clickLocatedElement(contents, {
            selector: '[role="menu"] [role="menuitem"]',
            textIncludes: targetValue,
            visibleOnly: true,
          });
          if (!itemClick.clicked) await this.sendKey(contents, "Escape");
          else await sleep(100);
        }
      }

      const targetVoiceLower = String(speakerConfig.voiceName || "").trim().toLowerCase();
      const voiceBtnMatch = await this.execJs(contents, `((regionSel, targetVoice) => {
        const region = document.querySelector(regionSel);
        if (!region) return { found: false };
        const btns = Array.from(region.querySelectorAll("button.voice-card-content, button[aria-label]:not(.play-icon)"));
        for (const btn of btns) {
          const ariaLabel = (btn.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
          const spanName = (btn.querySelector(".voice-name")?.textContent || "").replace(/\\s+/g, " ").trim();
          const fallbackText = (btn.textContent || "").replace(/\\s+/g, " ").trim();
          const rawLabel = ariaLabel || spanName || fallbackText;
          const normalized = rawLabel.replace(/\\s*\\(Current\\)\\s*$/i, "").trim().toLowerCase();
          if (normalized === targetVoice) {
            const alreadyCurrent = /\\(Current\\)$/i.test(ariaLabel || fallbackText);
            if (alreadyCurrent) return { found: true, alreadyCurrent: true };
            btn.scrollIntoView?.({ block: "center", inline: "center" });
            const rect = btn.getBoundingClientRect();
            return { found: true, alreadyCurrent: false, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }
        return { found: false };
      })(${JSON.stringify(availableVoicesSelector)}, ${JSON.stringify(targetVoiceLower)})`);

      if (!voiceBtnMatch.found) {
        throw new Error(`Could not find voice '${speakerConfig.voiceName}' in AI Studio Available voices`);
      }
      if (!voiceBtnMatch.alreadyCurrent) {
        await this.sendTrustedClick(contents, voiceBtnMatch.x, voiceBtnMatch.y);
        await sleep(200);
      }

      await this.clickLocatedElement(contents, { selector: closeDrawerSelector, visibleOnly: true }).catch(() => {});
      await sleep(150);
    }

    return { configured: pairCount };
  }

  async aiStudioSpeechCaptureState(_host, _tab, contents, args) {
    return await this.execJs(contents, `((opts) => {
      const errorPattern = new RegExp(opts.errorPatternSource, "i");
      let detectedError = "";
      for (const el of document.querySelectorAll(opts.errorSelector)) {
        const text = (el.innerText || el.textContent || "").trim();
        if (text && errorPattern.test(text)) {
          detectedError = text.replace(/\\s+/g, " ").slice(0, 300);
          break;
        }
      }
      const audioEl = document.querySelector("audio");
      const audioSrc = audioEl?.getAttribute("src") || "";
      const runBtn = document.querySelector(opts.runSelector);
      const runText = (runBtn?.innerText || runBtn?.textContent || "").trim().toLowerCase();
      const isGenerating = runText.includes("stop") || runText.includes("cancel") || Boolean(runBtn?.disabled);
      return { detectedError, audioSrc, isGenerating };
    })(${JSON.stringify(args)})`);
  }

  async aiStudioSpeechExtractAudio(_host, _tab, contents, args) {
    const audioSrc = typeof args.audioSrc === "string" ? args.audioSrc : "";
    const downloadSelector = args.downloadSelector || 'button.download-button[aria-label="Download"]';

    if (audioSrc) {
      const fetched = await this.execJs(contents, `(async (src) => {
        try {
          const res = await fetch(src);
          if (!res.ok) return null;
          const mimeType = res.headers.get("content-type") || "audio/wav";
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
          }
          return {
            mimeType: mimeType.split(";")[0].trim() || "audio/wav",
            audioBase64: btoa(binary),
            byteLength: bytes.length,
          };
        } catch {
          return null;
        }
      })(${JSON.stringify(audioSrc)})`).catch(() => null);

      if (fetched && fetched.byteLength > 0 && fetched.audioBase64) {
        return {
          audioBase64: fetched.audioBase64,
          mimeType: fetched.mimeType,
        };
      }
    }

    // Fallback qua Electron session will-download khi blob fetch không trả về dữ liệu
    const downloadSession = contents.session;
    const dlInfo = await this.queryElementCenter(contents, { selector: downloadSelector, visibleOnly: true });
    if (dlInfo && dlInfo.found && downloadSession && typeof downloadSession.once === "function") {
      const tempPath = path.join(os.tmpdir(), `aistudio-speech-${randomUUID()}.wav`);
      const downloaded = await new Promise((resolve) => {
        let settled = false;
        const finish = (val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(val);
        };
        const timer = setTimeout(() => finish(null), 10_000);
        const onWillDownload = (_event, item, itemContents) => {
          if (itemContents && itemContents !== contents) return;
          downloadSession.off?.("will-download", onWillDownload);
          item.setSavePath(tempPath);
          item.once("done", (_doneEvent, state) => {
            if (state === "completed") {
              try {
                const buffer = fs.readFileSync(tempPath);
                fs.rmSync(tempPath, { force: true });
                if (buffer.length > 0) {
                  finish({ audioBase64: buffer.toString("base64"), mimeType: "audio/wav" });
                  return;
                }
              } catch {}
            }
            fs.rmSync(tempPath, { force: true });
            finish(null);
          });
        };
        downloadSession.on("will-download", onWillDownload);
        void this.sendTrustedClick(contents, dlInfo.x, dlInfo.y);
      });
      if (downloaded) return downloaded;
    }

    return null;
  }
}

module.exports = {
  ALLOWED_ACTION_NAMES,
  SurfaceActionExecutor,
  normalizeCopiedAiStudioCodeSnippet,
  resolveClipboardMenuItemIndex,
};
