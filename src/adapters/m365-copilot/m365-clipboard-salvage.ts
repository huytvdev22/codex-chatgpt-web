import type { Page } from "playwright-core";

/**
 * Cứu hộ toàn bộ mã nguồn/văn bản từ Scriptor Code Block của Microsoft 365 Copilot.
 *
 * Đối với phản hồi dài (>70 dòng), Copilot dùng DOM Virtualization nên chỉ hiển thị
 * một phần dòng trong DOM; lớp này thử trích xuất đa tầng từ React Fiber Props,
 * Monaco Editor Global Model, nút Copy Code + Clipboard API hook, và fallback DOM `[data-line-index]`.
 */
export class M365ClipboardSalvage {
  /**
   * Thử trích xuất toàn bộ nội dung từ Code Block của tin nhắn AI mới nhất.
   */
  public async tryExtractCodeViaCopyButton(page: Page): Promise<string | null> {
    console.log("\n[m365-worker] [copy-salvage] ========================================================");
    console.log("[m365-worker] [copy-salvage] BẮT ĐẦU QUY TRÌNH CỨU HỘ MÃ NGUỒN QUA NÚT COPY CODE");
    console.log("[m365-worker] [copy-salvage] ========================================================");

    try {
      // Đảm bảo cửa sổ và tab có Focus để Chromium cho phép truy cập Clipboard API
      await page.bringToFront().catch(() => {});
      await page.evaluate(() => {
        try {
          window.focus();
          if (document.body) document.body.focus();
        } catch {}
      }).catch(() => {});

      // BƯỚC 1: Cấp quyền Clipboard CDP và cài đặt Hook đón nhận nội dung
      console.log("[m365-worker] [copy-salvage] [Bước 1/5] Đang cấp quyền Clipboard CDP & cài đặt Window Hook...");
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

      await page.evaluate(() => {
        const win = window as any;
        win.__m365_last_copied_code = null;
        const origWriteText = navigator.clipboard ? navigator.clipboard.writeText : null;
        if (navigator.clipboard) {
          navigator.clipboard.writeText = async (text: string) => {
            win.__m365_last_copied_code = text;
            try {
              if (origWriteText) return await origWriteText.call(navigator.clipboard, text);
            } catch {
              return Promise.resolve();
            }
          };
        }
        const onCopy = (e: ClipboardEvent) => {
          const text = e.clipboardData?.getData("text/plain") || window.getSelection()?.toString();
          if (text) win.__m365_last_copied_code = text;
        };
        document.addEventListener("copy", onCopy, { capture: true });
      });
      console.log("[m365-worker] [copy-salvage] [Bước 1/5] Đã thiết lập Clipboard Hook & quyền CDP thành công.");

      // BƯỚC 2: Định vị chính xác TIN NHẮN AI MỚI NHẤT và kiểm tra trạng thái Code Block
      console.log("[m365-worker] [copy-salvage] [Bước 2/5] Đang định vị tin nhắn AI mới nhất và kiểm tra trạng thái Code Block...");
      const blockState = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(
          ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
        )).filter(el => {
          if (el.matches("[data-content='user-message']") || el.querySelector("[data-content='user-message']")) return false;
          const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
          if (ariaLabel.includes("you said") || ariaLabel.includes("bạn đã nói")) return false;
          return true;
        });
        const aiList = candidates.filter((msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)));

        const freshList = aiList.filter(m => !m.hasAttribute("data-codex-turn-baseline"));
        const targetMsg = (freshList.length > 0 ? freshList[freshList.length - 1] : aiList[aiList.length - 1]) || document.body;
        const isFresh = freshList.length > 0;

        const codeBlocks = Array.from(targetMsg.querySelectorAll<HTMLElement>(
          ".scriptor-component-code-block, [class*='code-block' i], [data-testid='one-copilot-code-identity'], .djlfcDli"
        ));
        const targetBlock = codeBlocks.length > 0 ? codeBlocks[codeBlocks.length - 1] : targetMsg;

        const codeCopyBtn = targetBlock.querySelector<HTMLButtonElement>(
          "button#copy-button, button[aria-label='Copy code']"
        );

        const previewToggleBtn = targetBlock.querySelector<HTMLButtonElement>(
          "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code'], button[aria-label='Preview'], button[aria-label*='Code' i], button[aria-label*='Preview' i]"
        );

        const visualCopyBtn = targetBlock.querySelector<HTMLButtonElement>(
          "button#copy-visual-button, button[aria-label='Copy']"
        );

        const toggleAria = (previewToggleBtn?.getAttribute("aria-label") || "").toLowerCase();
        const isCurrentlyInCodeView = Boolean(codeCopyBtn) || toggleAria.includes("preview");
        const isCurrentlyInPreview = toggleAria.includes("code") || Boolean(visualCopyBtn);

        return {
          totalAiMessages: aiList.length,
          isFreshMessage: isFresh,
          hasCodeCopyBtn: !!codeCopyBtn,
          codeCopyLabel: codeCopyBtn ? (codeCopyBtn.getAttribute("aria-label") || codeCopyBtn.id) : null,
          hasPreviewToggle: !!previewToggleBtn,
          previewToggleLabel: previewToggleBtn ? (previewToggleBtn.getAttribute("aria-label") || previewToggleBtn.id) : null,
          hasVisualCopyBtn: !!visualCopyBtn,
          isCurrentlyInCodeView,
          isCurrentlyInPreview,
        };
      });

      console.log(`[m365-worker] [copy-salvage] [Bước 2/5] Đã nhắm vào tin nhắn AI mới nhất (Tổng: ${blockState.totalAiMessages} tin nhắn, Tin nhắn mới: ${blockState.isFreshMessage}).`);

      if (blockState.isCurrentlyInCodeView && blockState.hasCodeCopyBtn) {
        console.log(`[m365-worker] [copy-salvage] [Bước 2/5] Code Block ĐÃ Ở CHẾ ĐỘ CODE VIEW (nút copy: "${blockState.codeCopyLabel}").`);
      } else if (blockState.isCurrentlyInPreview || blockState.hasPreviewToggle) {
        console.log(`[m365-worker] [copy-salvage] [Bước 2/5] Code Block ĐANG Ở CHẾ ĐỘ PREVIEW (chỉ copy được ảnh). Cần click nút toggle "${blockState.previewToggleLabel}" của tin nhắn mới nhất để chuyển sang Code.`);
      } else {
        console.log("[m365-worker] [copy-salvage] [Bước 2/5] Không phát hiện toggle trực tiếp, sẽ quét và click nút ở cuối trang.");
      }

      // BƯỚC 3: Chuyển sang Chế độ Code (nếu đang ở Preview) và chờ Monaco Editor mount
      let hasCodeEditorReady = blockState.isCurrentlyInCodeView && blockState.hasCodeCopyBtn;
      if (!hasCodeEditorReady) {
        console.log("[m365-worker] [copy-salvage] [Bước 3/5] Đang kích hoạt click vào nút chuyển chế độ của tin nhắn mới nhất...");

        const domToggleClicked = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll<HTMLElement>(
            ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
          )).filter(el => {
            if (el.matches("[data-content='user-message']") || el.querySelector("[data-content='user-message']")) return false;
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            return !aria.includes("you said") && !aria.includes("bạn đã nói");
          });
          const aiList = candidates.filter((msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)));
          const freshList = aiList.filter(m => !m.hasAttribute("data-codex-turn-baseline"));
          const targetMsg = (freshList.length > 0 ? freshList[freshList.length - 1] : aiList[aiList.length - 1]) || document.body;

          const toggleBtn = targetMsg.querySelector<HTMLButtonElement>(
            "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code'], button[aria-label*='Code' i]"
          ) || Array.from(document.querySelectorAll<HTMLButtonElement>(
            "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code'], button[aria-label*='Code' i]"
          )).pop();

          if (toggleBtn) {
            toggleBtn.scrollIntoView({ block: "center", inline: "center" });
            toggleBtn.focus();
            toggleBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            toggleBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            toggleBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
            toggleBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            toggleBtn.click();
            return true;
          }
          return false;
        });

        if (domToggleClicked) {
          console.log("[m365-worker] [copy-salvage] [Bước 3/5] Đã phát sự kiện click chuyển chế độ vào tin nhắn mới nhất thành công.");
        } else {
          const toggleLocator = page.locator(".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']").last().locator(
            "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code']"
          ).last();
          if (await toggleLocator.count() > 0) {
            await toggleLocator.click({ timeout: 2000, force: true }).catch(() => {});
            console.log("[m365-worker] [copy-salvage] [Bước 3/5] Đã click nút toggle qua Playwright locator.");
          }
        }

        console.log("[m365-worker] [copy-salvage] [Bước 3/5] Đang chờ Monaco/Scriptor Code Editor render và xuất hiện button#copy-button...");
        const waitStart = Date.now();
        const maxWaitMs = 4000;
        while (Date.now() - waitStart < maxWaitMs) {
          await page.waitForTimeout(100);
          const checkReady = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll<HTMLElement>(
              ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
            )).filter(el => {
              if (el.matches("[data-content='user-message']") || el.querySelector("[data-content='user-message']")) return false;
              const aria = (el.getAttribute("aria-label") || "").toLowerCase();
              return !aria.includes("you said") && !aria.includes("bạn đã nói");
            });
            const aiList = candidates.filter((msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)));
            const freshList = aiList.filter(m => !m.hasAttribute("data-codex-turn-baseline"));
            const targetMsg = (freshList.length > 0 ? freshList[freshList.length - 1] : aiList[aiList.length - 1]) || document.body;

            const copyBtn = targetMsg.querySelector<HTMLButtonElement>("button#copy-button, button[aria-label='Copy code']");
            const toggleBtn = targetMsg.querySelector<HTMLButtonElement>("button#preview-toggle-button, button[data-automation-id='codePreviewToggle']");
            const toggleLabel = (toggleBtn?.getAttribute("aria-label") || "").toLowerCase();
            return Boolean(copyBtn || toggleLabel.includes("preview"));
          });

          if (checkReady) {
            hasCodeEditorReady = true;
            const elapsedMs = Date.now() - waitStart;
            console.log(`[m365-worker] [copy-salvage] [Bước 3/5] THÀNH CÔNG: Monaco Code Editor đã sẵn sàng sau ${elapsedMs}ms!`);
            await page.waitForTimeout(500);
            break;
          }
          const elapsed = Date.now() - waitStart;
          if (elapsed % 600 < 100) {
            console.log(`[m365-worker] [copy-salvage] [Bước 3/5] Đang đợi editor mount... (${elapsed}ms)`);
          }
        }
      }

      // BƯỚC 4: THỬ TRÍCH XUẤT ĐA TẦNG (Multi-tier Extraction)
      console.log("[m365-worker] [copy-salvage] [Bước 4/5] Đang kích hoạt trích xuất đa tầng (React Fiber, Monaco Global, CDP Click)...");

      // 4.1. Tầng A: Đọc trực tiếp từ React Fiber Props của component
      const reactFiberResult = await page.evaluate(() => {
        try {
          const candidates = Array.from(document.querySelectorAll<HTMLElement>(
            ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
          )).filter(el => {
            if (el.matches("[data-content='user-message']") || el.querySelector("[data-content='user-message']")) return false;
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            return !aria.includes("you said") && !aria.includes("bạn đã nói");
          });
          const aiList = candidates.filter((msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)));
          const freshList = aiList.filter(m => !m.hasAttribute("data-codex-turn-baseline"));
          const targetMsg = (freshList.length > 0 ? freshList[freshList.length - 1] : aiList[aiList.length - 1]) || document.body;

          const nodes = [targetMsg, ...Array.from(targetMsg.querySelectorAll<HTMLElement>("*"))];
          for (const el of nodes) {
            const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
            if (!fiberKey) continue;
            let fiber = (el as any)[fiberKey];
            let depth = 0;
            while (fiber && depth < 20) {
              const p = fiber.memoizedProps;
              if (p) {
                for (const propName of ["code", "text", "content", "value", "rawCode", "fileContent"]) {
                  if (typeof p[propName] === "string" && p[propName].length > 100 && /<(?:web|m365)Response\b|<custom_tool_call|\*{3}\s*Begin Patch/i.test(p[propName])) {
                    return { text: p[propName], source: `React Fiber Props (${propName})` };
                  }
                }
              }
              fiber = fiber.return;
              depth++;
            }
          }
        } catch {}
        return null;
      });

      if (reactFiberResult && reactFiberResult.text.trim().length > 0) {
        console.log(`[m365-worker] [copy-salvage] [Bước 4/5] THÀNH CÔNG RỰC RỠ: Trích xuất trực tiếp qua [${reactFiberResult.source}] (${reactFiberResult.text.length} ký tự)!`);
        return reactFiberResult.text.trim();
      }

      // 4.2. Tầng B: Đọc từ Monaco Editor Global Model
      const monacoResult = await page.evaluate(() => {
        try {
          const win = window as any;
          if (win.monaco?.editor?.getModels) {
            const models = win.monaco.editor.getModels();
            for (let i = models.length - 1; i >= 0; i--) {
              const val = models[i].getValue();
              if (val && val.length > 100 && /<(?:web|m365)Response\b|<custom_tool_call|\*{3}\s*Begin Patch/i.test(val)) {
                return { text: val, source: `Monaco Editor Model [${i}]` };
              }
            }
          }
        } catch {}
        return null;
      });

      if (monacoResult && monacoResult.text.trim().length > 0) {
        console.log(`[m365-worker] [copy-salvage] [Bước 4/5] THÀNH CÔNG RỰC RỠ: Trích xuất trực tiếp qua [${monacoResult.source}] (${monacoResult.text.length} ký tự)!`);
        return monacoResult.text.trim();
      }

      // 4.3. Tầng C: Kích hoạt click nút Copy Code của tin nhắn mới nhất
      console.log("[m365-worker] [copy-salvage] [Bước 4/5] Đang kích hoạt click vào nút Copy Code của tin nhắn mới nhất...");

      const domCopyClicked = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(
          ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
        )).filter(el => {
          if (el.matches("[data-content='user-message']") || el.querySelector("[data-content='user-message']")) return false;
          const aria = (el.getAttribute("aria-label") || "").toLowerCase();
          return !aria.includes("you said") && !aria.includes("bạn đã nói");
        });
        const aiList = candidates.filter((msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)));
        const freshList = aiList.filter(m => !m.hasAttribute("data-codex-turn-baseline"));
        const targetMsg = (freshList.length > 0 ? freshList[freshList.length - 1] : aiList[aiList.length - 1]) || document.body;

        const codeCopyBtn = targetMsg.querySelector<HTMLButtonElement>(
          "button#copy-button, button[aria-label='Copy code']"
        ) || Array.from(document.querySelectorAll<HTMLButtonElement>(
          "button#copy-button, button[aria-label='Copy code']"
        )).pop();

        if (codeCopyBtn) {
          codeCopyBtn.scrollIntoView({ block: "center", inline: "center" });
          codeCopyBtn.focus();
          codeCopyBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          codeCopyBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          codeCopyBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
          codeCopyBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          codeCopyBtn.click();
          return true;
        }
        return false;
      });

      if (domCopyClicked) {
        console.log("[m365-worker] [copy-salvage] [Bước 4/5] Đã phát sự kiện click DOM vào button#copy-button của tin nhắn mới nhất.");
      }

      try {
        const lastCopyLocator = page.locator(".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']").last().locator(
          "button#copy-button, button[aria-label='Copy code']"
        ).last();
        if (await lastCopyLocator.count() > 0) {
          await lastCopyLocator.scrollIntoViewIfNeeded().catch(() => {});
          await lastCopyLocator.click({ delay: 50, force: true }).catch(() => {});
          console.log("[m365-worker] [copy-salvage] [Bước 4/5] Đã click nút copy qua Playwright Locator trên tin nhắn cuối cùng.");
        }
      } catch {}

      // BƯỚC 5: Đón nhận mã nguồn từ Clipboard Hook / System Clipboard
      console.log("[m365-worker] [copy-salvage] [Bước 5/5] Đang đón nhận mã nguồn từ Clipboard Hook & Clipboard hệ thống...");
      const readStart = Date.now();
      let copiedText: string | null = null;
      let readSource = "";

      while (Date.now() - readStart < 3500) {
        await page.waitForTimeout(100);

        const hookResult = await page.evaluate(async () => {
          const win = window as any;
          if (typeof win.__m365_last_copied_code === "string" && win.__m365_last_copied_code.length > 0) {
            return { text: win.__m365_last_copied_code, source: "Window Hook (writeText)" };
          }
          try {
            if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
              const sys = await navigator.clipboard.readText();
              if (sys && sys.trim().length > 0) {
                return { text: sys, source: "System Clipboard (readText)" };
              }
            }
          } catch {}
          return null;
        });

        if (hookResult && typeof hookResult.text === "string" && hookResult.text.trim().length > 0) {
          copiedText = hookResult.text.trim();
          readSource = hookResult.source;
          break;
        }
      }

      if (copiedText && copiedText.length > 0) {
        const lineCount = copiedText.split(/\r?\n/).length;
        const hasOpenEnvelope = /<(?:web|m365)Response\b/i.test(copiedText);
        const hasCloseEnvelope = /<\/(?:web|m365)Response\s*>/i.test(copiedText);
        const hasPatchMarker = /(?:<custom_tool_call|\*{3}\s*Begin Patch)/i.test(copiedText);

        console.log(`[m365-worker] [copy-salvage] [Bước 5/5] THÀNH CÔNG RỰC RỠ qua nguồn: [${readSource}]!`);
        console.log(`[m365-worker] [copy-salvage] -> Thu thập được: ${copiedText.length} ký tự, ${lineCount} dòng mã nguồn.`);
        console.log(`[m365-worker] [copy-salvage] -> Kiểm tra cú pháp: có envelope mở: ${hasOpenEnvelope}, có envelope đóng: ${hasCloseEnvelope}, có patch marker: ${hasPatchMarker}.`);
        console.log("[m365-worker] [copy-salvage] ========================================================\n");
        return copiedText;
      }

      // 4.4. Tầng D: Fallback trích xuất trực tiếp từ các dòng DOM Virtualized [data-line-index]
      console.log("[m365-worker] [copy-salvage] [Bước 5/5] Clipboard rỗng, kích hoạt cứu hộ Fallback từ DOM [data-line-index]...");
      const domLinesResult = await page.evaluate(() => {
        try {
          const candidates = Array.from(document.querySelectorAll<HTMLElement>(
            ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']"
          )).filter(el => {
            if (el.matches("[data-content='user-message']") || el.querySelector("[data-content='user-message']")) return false;
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            return !aria.includes("you said") && !aria.includes("bạn đã nói");
          });
          const aiList = candidates.filter((msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)));
          const freshList = aiList.filter(m => !m.hasAttribute("data-codex-turn-baseline"));
          const targetMsg = (freshList.length > 0 ? freshList[freshList.length - 1] : aiList[aiList.length - 1]) || document.body;

          const lineEls = Array.from(targetMsg.querySelectorAll<HTMLElement>("[data-line-index]"));
          if (lineEls.length > 10) {
            lineEls.sort((a, b) => {
              const idxA = parseInt(a.getAttribute("data-line-index") || "0", 10);
              const idxB = parseInt(b.getAttribute("data-line-index") || "0", 10);
              return idxA - idxB;
            });
            const joined = lineEls.map(el => el.textContent || "").join("\n");
            if (joined.length > 100) return joined;
          }
        } catch {}
        return null;
      });

      if (domLinesResult && domLinesResult.trim().length > 0) {
        console.log(`[m365-worker] [copy-salvage] [Bước 5/5] THÀNH CÔNG: Đã trích xuất ${domLinesResult.trim().length} ký tự từ DOM [data-line-index]!`);
        console.log("[m365-worker] [copy-salvage] ========================================================\n");
        return domLinesResult.trim();
      }

      console.warn("[m365-worker] [copy-salvage] [Bước 5/5] THẤT BẠI: Hết 3.5s chờ nhưng không thu thập được code.");
      console.log("[m365-worker] [copy-salvage] ========================================================\n");
      return null;
    } catch (err: any) {
      console.warn(`[m365-worker] [copy-salvage] Ngoại lệ không mong muốn: ${err?.message || err}`);
      return null;
    }
  }
}
