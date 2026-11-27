const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Smoke test trên trình duyệt nhúng cho Google AI Studio (`gemini-4-hydrogen`).
 */
class AiStudioSmokeTester {
  async run({
    view,
    show,
    activateHomeSurface,
    waitForSurfaceReady,
    setState,
    logger,
    idleBrowserUrl,
    homeUrl,
  }) {
    show();
    activateHomeSurface();
    await waitForSurfaceReady();
    setState({ status: "testing", message: "Running Google AI Studio smoke test..." });

    let currentUrl = view.webContents.getURL() || "";
    if (!currentUrl || currentUrl === idleBrowserUrl || currentUrl === "about:blank" || !currentUrl.includes("aistudio.google.com")) {
      await view.webContents.loadURL(homeUrl);
      currentUrl = view.webContents.getURL() || "";
    }
    const isAiStudio = currentUrl.includes("aistudio.google.com");
    const isLogin = currentUrl.includes("accounts.google.com");
    if (!isAiStudio || isLogin) {
      throw new Error("Vui lòng đăng nhập vào Google AI Studio trước khi chạy kiểm tra!");
    }

    const editorReady = await view.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const composer = document.querySelector('textarea[aria-label="Enter a prompt"]');
        if (composer) return true;
        await new Promise(resolve => setTimeout(resolve, 350));
      }
      return false;
    })()`, true);

    if (!editorReady) {
      throw new Error("Không tìm thấy ô nhập prompt của Google AI Studio!");
    }

    const dismissedWelcome = await view.webContents.executeJavaScript(`(() => {
      const container =
        document.querySelector("#g1-welcome-dialog") ||
        document.querySelector("ms-g1-welcome-dialog") ||
        document.querySelector("ms-tos-disclaimer")?.closest("mat-dialog-container");
      if (!container) return false;
      const btn =
        container.querySelector("[mat-dialog-actions] button.ms-button-primary:not([disabled]):not([aria-disabled='true'])") ||
        container.querySelector("button.ms-button-primary:not([disabled]):not([aria-disabled='true'])") ||
        container.querySelector("[mat-dialog-actions] button:not([disabled]):not([aria-disabled='true'])") ||
        container.querySelector('button[aria-label="Close dialog"]:not([disabled]):not([aria-disabled="true"])');
      if (!btn) return false;
      btn.click();
      return true;
    })()`, true).catch(() => false);
    if (dismissedWelcome) {
      await sleep(350);
    }

    const promptText = "Reply with exactly: CODEX WEB GPT READY";
    setState({ status: "testing", message: "Sending smoke test prompt to Google AI Studio..." });

    view.webContents.focus();
    await view.webContents.executeJavaScript(`((text) => {
      const composer = document.querySelector('textarea[aria-label="Enter a prompt"]');
      if (!composer) return false;
      composer.focus();
      const proto = HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })(${JSON.stringify(promptText)})`, true);

    await sleep(300);

    await view.webContents.executeJavaScript(`(() => {
      const btn = document.querySelector('button[ms-button].ctrl-enter-submits.ms-button-primary');
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        btn.click();
        return true;
      }
      return false;
    })()`, true);

    setState({ status: "testing", message: "Waiting for Google AI Studio response..." });
    const deadline = Date.now() + 60_000;
    let passed = false;

    while (Date.now() < deadline) {
      const probe = await view.webContents.executeJavaScript(`(() => {
        const turns = Array.from(document.querySelectorAll('.chat-session-content .chat-turn-container.model'))
          .filter(el => !el.querySelector('mat-expansion-panel.thought-panel'));
        const last = turns[turns.length - 1];
        const text = last ? (last.innerText || last.textContent || "") : "";
        if (text.includes("CODEX WEB GPT READY")) return { ok: true };
        if (last && !last.querySelector('.turn-footer') && /permission denied|failed to generate content/i.test(text)) {
          return { ok: false, error: text.trim() };
        }
        const snack = document.querySelector('mat-snack-bar-container, simple-snack-bar, [role="alert"]');
        const snackText = snack ? (snack.innerText || snack.textContent || "").trim() : "";
        if (snackText && /permission denied|failed to generate|error|quota|unauthorized/i.test(snackText)) {
          return { ok: false, error: snackText };
        }
        return { ok: false };
      })()`, true).catch(() => ({ ok: false }));

      if (probe?.error) {
        throw new Error(`Google AI Studio từ chối yêu cầu: ${probe.error}`);
      }
      if (probe?.ok) {
        passed = true;
        break;
      }
      await sleep(500);
    }

    if (!passed) {
      throw new Error("Google AI Studio smoke test không nhận được phản hồi 'CODEX WEB GPT READY' kịp thời. Vui lòng thử lại!");
    }

    logger?.info?.("smoke.ai_studio_completed");
    setState({ status: "ready", message: "Smoke test passed", authenticated: true });
    return { ok: true, effort: "high", response: "CODEX WEB GPT READY" };
  }
}

module.exports = { AiStudioSmokeTester };

