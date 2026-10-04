import { stripOuterCodeFence } from "./stripCodeFence";

export interface FastPathExtraction {
  isFastPath: boolean;
  codeText: string;
  lang: string;
  lineCount: number;
}

/**
 * Hàm trích xuất Fast-Path chạy trực tiếp trên LIVE DOM của browser context.
 * Quét Scriptor Code Block và lấy raw text từ các thẻ [data-line-index] mà không qua Turndown.
 */
export function extractFastPathFromDom(contentEl: HTMLElement): FastPathExtraction | null {
  const codeBlockQuery = "div[role='group'][aria-label='Code Preview'], .scriptor-component-code-block, [class*='scriptor-component-code-block']";
  const allLiveCodeElements = Array.from(contentEl.querySelectorAll(codeBlockQuery)) as HTMLElement[];
  const liveCodeBlocks = allLiveCodeElements.filter((el, _, all) => !all.some(other => other !== el && other.contains(el)));

  if (liveCodeBlocks.length === 0) {
    return null;
  }

  // Fast-Path áp dụng tối ưu khi Copilot gói toàn bộ câu trả lời trong 1 khối code block duy nhất,
  // hoặc khối đầu tiên có nhãn ngôn ngữ là markdown / plain text
  const targetBlock = liveCodeBlocks[0];
  const langEl = targetBlock.querySelector("[data-testid='one-copilot-code-identity'] span, [class*='code-identity' i] span");
  let lang = langEl?.textContent?.trim().toLowerCase() || "";
  if (lang === "plain text" || lang === "text") lang = "plain";

  const isMarkdownOrText = !lang || lang === "markdown" || lang === "md" || lang === "plain";
  const isSingleBlock = liveCodeBlocks.length === 1;

  // Nếu có nhiều khối và khối đầu không phải markdown/plain, không an toàn để dùng Fast-Path đơn
  if (!isSingleBlock && !isMarkdownOrText) {
    return null;
  }

  // Trích xuất toàn bộ text từ các thẻ data-line-index (đã xác thực không bị ảo hóa DOM)
  const lineEls = Array.from(targetBlock.querySelectorAll("[data-line-index]"));
  let rawText = "";

  if (lineEls.length > 0) {
    rawText = lineEls.map(el => (el.textContent || "").replace(/\u00a0/g, " ")).join("\n");
  } else {
    const findRoot = targetBlock.querySelector("[data-virtualized-code-find-root='true'], [role='textbox'][aria-label*='Code editor' i]") || targetBlock.lastElementChild;
    rawText = (findRoot ? (findRoot as HTMLElement).innerText : (targetBlock as HTMLElement).innerText || "").replace(/\u00a0/g, " ");
  }

  rawText = rawText.replace(/^\n+|\n+$/g, "");

  return {
    isFastPath: true,
    codeText: rawText,
    lang,
    lineCount: lineEls.length,
  };
}

/**
 * Bộ đệm phát dòng (Stream Buffer) cho Fast-Path
 * Theo dõi chuỗi text đang sinh từ Scriptor Editor và emit delta mới tăng dần
 */
export class FastPathStreamBuffer {
  private streamedLength = 0;
  private fullText = "";

  observe(currentRawText?: string | null): string {
    const text = typeof currentRawText === "string" ? currentRawText : "";
    this.fullText = text;
    if (text.length > this.streamedLength) {
      const delta = text.slice(this.streamedLength);
      this.streamedLength = text.length;
      return delta;
    }
    return "";
  }

  finish(finalRawText?: string | null): { markdown: string; delta: string } {
    const textToFinish = typeof finalRawText === "string" ? finalRawText : this.fullText;
    let delta = "";
    if (textToFinish.length > this.streamedLength) {
      delta = textToFinish.slice(this.streamedLength);
      this.streamedLength = textToFinish.length;
    }
    this.fullText = textToFinish;
    return {
      markdown: this.fullText,
      delta,
    };
  }

  getText(): string {
    return this.fullText;
  }
}
