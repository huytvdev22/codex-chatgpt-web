const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Smoke test trên trình duyệt nhúng cho ChatGPT Web (`chatgpt.com`).
 */
class ChatGptSmokeTester {
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
    setState({ status: "testing", message: "Running ChatGPT smoke test..." });

    let currentUrl = view.webContents.getURL() || "";
    if (!currentUrl || currentUrl === idleBrowserUrl || currentUrl === "about:blank" || !currentUrl.includes("chatgpt.com")) {
      await view.webContents.loadURL(homeUrl);
      currentUrl = view.webContents.getURL() || "";
    }

    const authCheck = typeof probeAuthentication === "function"
      ? await probeAuthentication(view.webContents).catch(() => null)
      : null;
    if (authCheck && authCheck.authenticated === false) {
      throw new Error("Vui lòng đăng nhập vào ChatGPT trước khi chạy kiểm tra!");
    }

    const editorReady = await view.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const editors = Array.from(document.querySelectorAll('div.ProseMirror[data-composer-markdown][role="textbox"], #prompt-textarea'));
        const visible = editors.find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (visible) return true;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return false;
    })()`, true);

    if (!editorReady) {
      throw new Error("Không tìm thấy ô nhập prompt của ChatGPT!");
    }

    const promptText = "Reply with exactly: CODEX WEB GPT READY";
    setState({ status: "testing", message: "Sending smoke test prompt to ChatGPT..." });

    view.webContents.focus();
    await view.webContents.executeJavaScript(`((text) => {
      const editors = Array.from(document.querySelectorAll('div.ProseMirror[data-composer-markdown][role="textbox"], #prompt-textarea'));
      const composer = editors.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }) || editors[0];
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
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })(${JSON.stringify(promptText)})`, true);

    await sleep(350);

    await view.webContents.executeJavaScript(`(() => {
      const selectors = [
        'button[type="submit"][aria-label="Send"]',
        'button[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]',
        'button[aria-label="Send"]',
      ];
      for (const selector of selectors) {
        for (const btn of document.querySelectorAll(selector)) {
          const r = btn.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          if (!btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
            btn.click();
            return true;
          }
        }
      }
      return false;
    })()`, true);

    setState({ status: "testing", message: "Waiting for ChatGPT response..." });
    const deadline = Date.now() + 60_000;
    let passed = false;

    while (Date.now() < deadline) {
      const probe = await view.webContents.executeJavaScript(`(() => {
        const messages = Array.from(document.querySelectorAll('[data-markdown-text-style="assistant-message"]'));
        const last = messages[messages.length - 1];
        const text = last ? (last.textContent || "") : "";
        if (text.includes("CODEX WEB GPT READY")) return { ok: true };
        for (const alertEl of document.querySelectorAll('.text-token-text-error, [role="alert"], [data-testid="error-banner"]')) {
          if (alertEl.closest('[data-markdown-text-style="assistant-message"]')) continue;
          const r = alertEl.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) continue;
          const alertText = (alertEl.innerText || alertEl.textContent || "").trim();
          if (alertText && /limit|error|expired|unusual activity|something went wrong|too many/i.test(alertText)) {
            return { ok: false, error: alertText };
          }
        }
        return { ok: false };
      })()`, true).catch(() => ({ ok: false }));

      if (probe?.error) {
        throw new Error(`ChatGPT từ chối yêu cầu: ${probe.error}`);
      }
      if (probe?.ok) {
        passed = true;
        break;
      }
      await sleep(500);
    }

    if (!passed) {
      throw new Error("ChatGPT smoke test không nhận được phản hồi 'CODEX WEB GPT READY' kịp thời. Vui lòng thử lại!");
    }

    logger?.info?.("smoke.chatgpt_completed");
    setState({ status: "ready", message: "Smoke test passed", authenticated: true });
    return { ok: true, effort: "medium", response: "CODEX WEB GPT READY" };
  }
}

module.exports = { ChatGptSmokeTester };
