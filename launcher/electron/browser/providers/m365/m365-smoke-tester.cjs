const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Đóng gói kịch bản smoke test cho Microsoft 365 Copilot để tách rời logic
 * kiểm tra DOM/editor khỏi BrowserHost.
 */
class M365SmokeTester {
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
    setState({ status: "testing", message: "Running M365 Copilot smoke test..." });

    let currentUrl = view.webContents.getURL() || "";
    if (!currentUrl || currentUrl === idleBrowserUrl || currentUrl === "about:blank") {
      await view.webContents.loadURL(homeUrl);
      currentUrl = view.webContents.getURL() || "";
    }
    const isM365 = currentUrl.includes("m365.cloud.microsoft") || currentUrl.includes("copilot.cloud.microsoft");
    const isLogin = currentUrl.includes("login.microsoftonline.com")
      || currentUrl.includes("login.live.com")
      || /^https:\/\/[^/]*\.cloud\.microsoft\/login(?:[/?#]|$)/i.test(currentUrl);
    if (!isM365 || isLogin) {
      throw new Error("Vui lòng đăng nhập vào Microsoft 365 Copilot trước khi chạy kiểm tra!");
    }

    const editorReady = await view.webContents.executeJavaScript(`(async () => {
      const maxWait = 15000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const editor = document.querySelector('#m365-chat-editor-target-element, div[contenteditable="true"], [role="textbox"]');
        if (editor) return true;
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      return false;
    })()`, true);

    if (!editorReady) {
      throw new Error("Không tìm thấy khung nhập liệu của Microsoft 365 Copilot!");
    }

    const promptText = "Reply with exactly: CODEX WEB GPT READY";
    setState({ status: "testing", message: "Sending smoke test prompt to M365 Copilot..." });

    view.webContents.focus();
    await view.webContents.executeJavaScript(`(() => {
      const editor = document.getElementById("m365-chat-editor-target-element") ||
        document.querySelector("span[contenteditable='true']") ||
        document.querySelector("div[contenteditable='true']") ||
        document.querySelector("[role='textbox']");
      if (editor) {
        editor.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.execCommand("delete", false, undefined);
        return true;
      }
      return false;
    })()`, true);

    await view.webContents.insertText(promptText);

    await view.webContents.executeJavaScript(`((text) => {
      const editor = document.getElementById("m365-chat-editor-target-element") ||
        document.querySelector("span[contenteditable='true']") ||
        document.querySelector("div[contenteditable='true']") ||
        document.querySelector("[role='textbox']");
      if (editor && (!editor.textContent || !editor.textContent.includes(text))) {
        editor.focus();
        document.execCommand("insertText", false, text);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        editor.dispatchEvent(new Event("change", { bubbles: true }));
      }
    })(${JSON.stringify(promptText)})`, true);

    await sleep(400);

    await view.webContents.executeJavaScript(`(() => {
      const sendBtn = document.querySelector(
        '.fai-SendButton, button[aria-label="Send"], button[aria-label*="Send" i], button[aria-label*="Submit" i], button[aria-label*="Gửi" i], [data-testid="send-button"]'
      );
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        return true;
      }
      return false;
    })()`, true);

    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    view.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });

    setState({ status: "testing", message: "Waiting for M365 Copilot response..." });
    const maxWaitMs = 60000;
    const pollIntervalMs = 500;
    const startTime = Date.now();
    let passed = false;

    while (Date.now() - startTime < maxWaitMs) {
      const responseText = await view.webContents.executeJavaScript(`(() => {
        const selectors = [
          '.fai-CopilotMessage',
          '[data-content="ai-message"]',
          '.fui-ChatMessage',
          '[role="article"]',
          '.fai-ChatMessage',
          '[data-content="copilot-message"]',
          'div[class*="CopilotMessage"]',
          'div[class*="chatMessage" i]',
          '[aria-label*="Copilot" i]',
        ];
        for (const sel of selectors) {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length > 0) {
            const last = els[els.length - 1];
            const text = last ? (last.innerText || last.textContent || "") : "";
            if (text.includes("CODEX WEB GPT READY")) return text;
          }
        }
        const allText = document.body ? (document.body.innerText || "") : "";
        if (allText.includes("CODEX WEB GPT READY")) {
          const firstIdx = allText.indexOf("CODEX WEB GPT READY");
          const lastIdx = allText.lastIndexOf("CODEX WEB GPT READY");
          if (lastIdx > firstIdx || allText.includes("CODEX WEB GPT READY\\n") || allText.includes("\\nCODEX WEB GPT READY")) {
            return "CODEX WEB GPT READY";
          }
        }
        return "";
      })()`, true).catch(() => "");

      if (responseText.includes("CODEX WEB GPT READY")) {
        passed = true;
        break;
      }
      await sleep(pollIntervalMs);
    }

    if (!passed) {
      throw new Error("M365 Copilot smoke test không nhận được phản hồi 'CODEX WEB GPT READY' kịp thời. Vui lòng thử lại!");
    }

    logger?.info?.("smoke.m365_completed");
    setState({ status: "ready", message: "Smoke test passed", authenticated: true });
    return { ok: true, effort: "fast", response: "CODEX WEB GPT READY" };
  }
}

module.exports = { M365SmokeTester };

