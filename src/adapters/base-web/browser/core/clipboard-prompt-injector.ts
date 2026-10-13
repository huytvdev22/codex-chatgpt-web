import type { Page } from "playwright-core";
import type { IPromptInjector } from "../contracts/prompt-injector.interface";
import type { ChatSelectorsDto } from "../dto/chat-selectors.dto";
import type { BrowserTurnOptionsDto } from "../dto/browser-turn-options.dto";

/**
 * Trình chèn prompt nguyên tử qua sự kiện dán Clipboard (ClipboardEvent paste).
 * Hoạt động trên mọi khung soạn thảo hiện đại (ProseMirror, Lexical, Draft.js, contenteditable, textarea).
 */
export class ClipboardPromptInjector implements IPromptInjector {
  public async inject(
    page: Page,
    prompt: string,
    selectors: ChatSelectorsDto,
    _options: BrowserTurnOptionsDto
  ): Promise<void> {
    await page.evaluate(
      (params: { editorSelector: string; text: string }) => {
        const editor = document.querySelector(params.editorSelector) as HTMLElement | null;
        if (!editor) {
          throw new Error(`[ClipboardPromptInjector] Không tìm thấy phần tử editor với selector: ${params.editorSelector}`);
        }

        // Focus vào editor
        editor.focus();

        // Xóa nội dung cũ nếu có
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.execCommand("delete", false, undefined);

        // Chèn văn bản qua sự kiện Paste nguyên tử
        const dt = new DataTransfer();
        dt.setData("text/plain", params.text);
        editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        editor.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { editorSelector: selectors.editor, text: prompt }
    );
  }
}
