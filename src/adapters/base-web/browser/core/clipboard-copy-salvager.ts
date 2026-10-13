import type { Page } from "playwright-core";
import type { ICodeSalvager } from "../contracts/code-salvager.interface";

export interface SalvageSelectorsOptions {
  aiMessageSelector?: string;
  userMessageSelector?: string;
  codeBlockSelector?: string;
  copyButtonSelector?: string;
  previewToggleSelector?: string;
}

const DEFAULT_SALVAGE_SELECTORS: Required<SalvageSelectorsOptions> = {
  aiMessageSelector: ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
  userMessageSelector: "[data-content='user-message']",
  codeBlockSelector: ".scriptor-component-code-block, [class*='code-block' i], [data-testid='one-copilot-code-identity'], .djlfcDli",
  copyButtonSelector: "button#copy-button, button[aria-label='Copy code'], button[aria-label='Copy']",
  previewToggleSelector: "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code'], button[aria-label*='Code' i]",
};

/**
 * Bộ cứu hộ mã nguồn từ DOM bị ảo hóa (DOM Virtualization Salvager).
 * Đối với các phản hồi dài (>70 dòng), các mô hình web AI (Copilot, ChatGPT, Claude)
 * thường dùng DOM virtualization chỉ render một phần và giấu phần còn lại trong spacer div.
 * Lớp này kết nối với nút Copy Code và bắt hook navigator.clipboard.writeText để lấy 100% nội dung gốc.
 */
export class ClipboardCopySalvager implements ICodeSalvager {
  private readonly selectors: Required<SalvageSelectorsOptions>;

  constructor(customSelectors?: SalvageSelectorsOptions) {
    this.selectors = {
      ...DEFAULT_SALVAGE_SELECTORS,
      ...customSelectors,
    };
  }

  public async salvage(page: Page): Promise<string | null> {
    console.log("\n[clipboard-salvage] ========================================================");
    console.log("[clipboard-salvage] BẮT ĐẦU QUY TRÌNH CỨU HỘ MÃ NGUỒN QUA NÚT COPY CODE");
    console.log("[clipboard-salvage] ========================================================");

    try {
      await page.bringToFront().catch(() => {});
      await page.evaluate(() => {
        try {
          window.focus();
          if (document.body) document.body.focus();
        } catch {}
      }).catch(() => {});

      // BƯỚC 1: Cấp quyền Clipboard CDP và cài Window Hook
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

      await page.evaluate(() => {
        const win = window as any;
        win.__base_web_last_copied_code = null;
        const origWriteText = navigator.clipboard ? navigator.clipboard.writeText : null;
        if (navigator.clipboard) {
          navigator.clipboard.writeText = async (text: string) => {
            win.__base_web_last_copied_code = text;
            try {
              if (origWriteText) return await origWriteText.call(navigator.clipboard, text);
            } catch {
              return Promise.resolve();
            }
          };
        }
        const onCopy = (e: ClipboardEvent) => {
          const text = e.clipboardData?.getData("text/plain") || window.getSelection()?.toString();
          if (text) win.__base_web_last_copied_code = text;
        };
        document.addEventListener("copy", onCopy, { capture: true });
      });

      // BƯỚC 2: Định vị tin nhắn AI mới nhất và kiểm tra trạng thái Code Block
      const selectors = this.selectors;
      const blockState = await page.evaluate((sel) => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(sel.aiMessageSelector)).filter(el => {
          if (el.matches(sel.userMessageSelector) || el.querySelector(sel.userMessageSelector)) return false;
          const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
          if (ariaLabel.includes("you said") || ariaLabel.includes("bạn đã nói")) return false;
          return true;
        });
        const aiList = candidates.filter((msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)));
        const freshList = aiList.filter(m => !m.hasAttribute("data-codex-turn-baseline"));
        const targetMsg = (freshList.length > 0 ? freshList[freshList.length - 1] : aiList[aiList.length - 1]) || document.body;

        const codeBlocks = Array.from(targetMsg.querySelectorAll<HTMLElement>(sel.codeBlockSelector));
        const targetBlock = codeBlocks.length > 0 ? codeBlocks[codeBlocks.length - 1] : targetMsg;

        const codeCopyBtn = targetBlock.querySelector<HTMLButtonElement>(sel.copyButtonSelector);
        const previewToggleBtn = targetBlock.querySelector<HTMLButtonElement>(sel.previewToggleSelector);

        const toggleAria = (previewToggleBtn?.getAttribute("aria-label") || "").toLowerCase();
        const isCurrentlyInCodeView = Boolean(codeCopyBtn) || toggleAria.includes("preview");

        return {
          totalAiMessages: aiList.length,
          hasCodeCopyBtn: !!codeCopyBtn,
          hasPreviewToggle: !!previewToggleBtn,
          isCurrentlyInCodeView,
        };
      }, selectors);

      // BƯỚC 3: Nếu đang ở preview mode, bấm toggle sang code view
      if (!blockState.isCurrentlyInCodeView && blockState.hasPreviewToggle) {
        await page.evaluate((sel) => {
          const toggleBtn = document.querySelector<HTMLButtonElement>(sel.previewToggleSelector);
          if (toggleBtn) {
            toggleBtn.scrollIntoView({ block: "center", inline: "center" });
            toggleBtn.click();
          }
        }, selectors).catch(() => {});
        await page.waitForTimeout(500);
      }

      // BƯỚC 4: Click nút Copy Code
      const clickSuccess = await page.evaluate((sel) => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(sel.aiMessageSelector)).filter(el => {
          if (el.matches(sel.userMessageSelector) || el.querySelector(sel.userMessageSelector)) return false;
          const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
          return !ariaLabel.includes("you said") && !ariaLabel.includes("bạn đã nói");
        });
        const aiList = candidates.filter((msg, idx, all) => !all.some((other, oIdx) => oIdx !== idx && other.contains(msg)));
        const freshList = aiList.filter(m => !m.hasAttribute("data-codex-turn-baseline"));
        const targetMsg = (freshList.length > 0 ? freshList[freshList.length - 1] : aiList[aiList.length - 1]) || document.body;

        const codeBlocks = Array.from(targetMsg.querySelectorAll<HTMLElement>(sel.codeBlockSelector));
        const targetBlock = codeBlocks.length > 0 ? codeBlocks[codeBlocks.length - 1] : targetMsg;

        const copyBtn = targetBlock.querySelector<HTMLButtonElement>(sel.copyButtonSelector) ||
          Array.from(document.querySelectorAll<HTMLButtonElement>(sel.copyButtonSelector)).pop();

        if (copyBtn) {
          copyBtn.scrollIntoView({ block: "center", inline: "center" });
          copyBtn.focus();
          copyBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          copyBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          copyBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
          copyBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          copyBtn.click();
          return true;
        }
        return false;
      }, selectors).catch(() => false);

      if (clickSuccess) {
        await page.waitForTimeout(300);
      }

      // BƯỚC 5: Đọc nội dung hook đã thu thập được
      const copiedText = await page.evaluate(() => {
        return (window as any).__base_web_last_copied_code || (window as any).__m365_last_copied_code || null;
      });

      if (copiedText && typeof copiedText === "string" && copiedText.trim().length > 0) {
        console.log(`[clipboard-salvage] Cứu hộ thành công! Thu được ${copiedText.length} ký tự từ nút Copy.`);
        return copiedText;
      }

      return null;
    } catch (err) {
      console.warn("[clipboard-salvage] Lỗi trong quá trình cứu hộ mã nguồn:", err);
      return null;
    }
  }
}
