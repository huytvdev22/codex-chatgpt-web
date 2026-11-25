const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Smoke test trên trình duyệt nhúng cho Gemini Web (`gemini.google.com`).
 */
class GeminiSmokeTester {
  async run({
    view,
    show,
    activateHomeSurface,
    waitForSurfaceReady,
    setState,
    logger,
    idleBrowserUrl,
    homeUrl,
    probeAuthentication,
  }) {
    show();
    activateHomeSurface();
    await waitForSurfaceReady();
    setState({ status: "testing", message: "Running Gemini smoke test..." });

    let currentUrl = view.webContents.getURL() || "";
    if (!currentUrl || currentUrl === idleBrowserUrl || currentUrl === "about:blank" || !currentUrl.includes("gemini.google.com")) {
      await view.webContents.loadURL(homeUrl);
      currentUrl = view.webContents.getURL() || "";
    }

    const authCheck = typeof probeAuthentication === "function"
      ? await probeAuthentication(view.webContents).catch(() => null)
      : null;
    if (authCheck && authCheck.authenticated === false) {
      throw new Error("Vui lòng đăng nhập vào Gemini trước khi chạy kiểm tra!");
    }

    const editorReady = await view.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const selectors = [
          'rich-textarea .ql-editor[contenteditable="true"][role="textbox"]',
          'div.ql-editor[contenteditable="true"][role="textbox"]',
          '[role="textbox"][contenteditable="true"]',
        ];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return true;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return false;
    })()`, true);

    if (!editorReady) {
      throw new Error("Không tìm thấy ô nhập prompt của Gemini!");
    }

    const baselineCount = await view.webContents.executeJavaScript(
      `document.querySelectorAll('model-response').length`,
      true,
    ).catch(() => 0);

    const promptText = "Reply with exactly: CODEX WEB GPT READY";
    setState({ status: "testing", message: "Sending smoke test prompt to Gemini..." });

    view.webContents.focus();
    await view.webContents.executeJavaScript(`((text) => {
      const selectors = [
        'rich-textarea .ql-editor[contenteditable="true"][role="textbox"]',
        'div.ql-editor[contenteditable="true"][role="textbox"]',
        '[role="textbox"][contenteditable="true"]',
      ];
      let composer = null;
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            composer = el;
            break;
          }
        }
      }
      if (!composer) return false;
      composer.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("delete", false, undefined);
      document.execCommand("insertText", false, text);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })(${JSON.stringify(promptText)})`, true);

    await sleep(350);

    await view.webContents.executeJavaScript(`(() => {
      const selectors = [
        'button[aria-label="Send message"]',
        'button.send-button',
        'button[aria-label*="Send" i]',
      ];
      for (const selector of selectors) {
        for (const btn of document.querySelectorAll(selector)) {
          const rect = btn.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (!btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
            btn.click();
            return true;
          }
        }
      }
      return false;
    })()`, true);

    setState({ status: "testing", message: "Waiting for Gemini response..." });
    const deadline = Date.now() + 60_000;
    let passed = false;

    while (Date.now() < deadline) {
      const probe = await view.webContents.executeJavaScript(`((baseCount) => {
        const responses = Array.from(document.querySelectorAll('model-response'));
        if (responses.length <= baseCount) return { ok: false };
        const last = responses[responses.length - 1];
        const panel = last.querySelector('message-content .markdown-main-panel') || last.querySelector('message-content') || last;
        const clone = panel.cloneNode(true);
        for (const noise of clone.querySelectorAll('thinking-overlay, model-thoughts, .thoughts-container, button')) {
          noise.remove();
        }
        const text = (clone.textContent || "");
        const busy = panel.getAttribute("aria-busy") === "true";
        if (!busy && text.includes("CODEX WEB GPT READY")) return { ok: true };
        const err = document.querySelector('.error-banner, mat-snack-bar-container, simple-snack-bar, [role="alert"]');
        const errText = err ? (err.innerText || err.textContent || "").trim() : "";
        if (errText && /something went wrong|limit|error|expired|unavailable/i.test(errText)) {
          return { ok: false, error: errText };
        }
        return { ok: false };
      })(${Number(baselineCount) || 0})`, true).catch(() => ({ ok: false }));

      if (probe?.error) {
        throw new Error(`Gemini từ chối yêu cầu: ${probe.error}`);
      }
      if (probe?.ok) {
        passed = true;
        break;
      }
      await sleep(500);
    }

    if (!passed) {
      throw new Error("Gemini smoke test không nhận được phản hồi 'CODEX WEB GPT READY' kịp thời. Vui lòng thử lại!");
    }

    logger?.info?.("smoke.gemini_completed");
    setState({ status: "ready", message: "Smoke test passed", authenticated: true });
    return { ok: true, effort: "medium", response: "CODEX WEB GPT READY" };
  }
}

module.exports = { GeminiSmokeTester };
