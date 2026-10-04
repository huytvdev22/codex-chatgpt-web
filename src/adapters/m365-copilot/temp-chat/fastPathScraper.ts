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
 * Tìm độ dài đoạn giao thoa (overlap) giữa đuôi của existing và đầu của incoming.
 * Phục vụ cho cơ chế chống mất đầu khi trình duyệt kích hoạt DOM Virtualization (cuộn xuống đáy và unmount các dòng trên).
 */
export function findSuffixPrefixOverlap(existing: string, incoming: string, minOverlap = 10): number {
  if (!existing || !incoming) return 0;
  const maxSearch = Math.min(existing.length, incoming.length, 4000);
  for (let len = maxSearch; len >= minOverlap; len--) {
    const suffix = existing.slice(existing.length - len);
    if (incoming.startsWith(suffix)) {
      return len;
    }
  }
  return 0;
}

/**
 * Bộ đệm phát dòng (Stream Buffer) cho Fast-Path
 * Theo dõi chuỗi text đang sinh từ Scriptor Editor và emit delta mới tăng dần.
 * Tích hợp cơ chế tự phục hồi và bảo toàn chuỗi khi Monaco/Scriptor kích hoạt DOM Virtualization.
 */
export class FastPathStreamBuffer {
  private streamedLength = 0;
  private fullText = "";

  observe(currentRawText?: string | null): string {
    const text = typeof currentRawText === "string" ? currentRawText : "";
    if (!text) return "";

    // 1. Khởi tạo lần đầu
    if (!this.fullText) {
      this.fullText = text;
      this.streamedLength = text.length;
      return text;
    }

    // 2. Trường hợp bình thường (văn bản tích lũy từ đầu, không bị ảo hóa DOM)
    if (text.startsWith(this.fullText)) {
      const delta = text.slice(this.streamedLength);
      this.fullText = text;
      this.streamedLength = text.length;
      return delta;
    }

    // 3. Trường hợp text mới dài hơn và có chung phần đầu lớn
    if (this.fullText.length > 50 && text.startsWith(this.fullText.slice(0, 50))) {
      if (text.length > this.fullText.length) {
        const delta = text.slice(this.fullText.length);
        this.fullText = text;
        this.streamedLength = text.length;
        return delta;
      }
      return "";
    }

    // 4. Trường hợp DOM Virtualization (text mới bị mất phần đầu do Scriptor cuộn xuống đáy)
    // Tìm điểm giao thoa giữa đuôi của fullText và đầu của text mới
    const overlapLen = findSuffixPrefixOverlap(this.fullText, text, 10);
    if (overlapLen > 0) {
      const newPart = text.slice(overlapLen);
      if (newPart.length > 0) {
        this.fullText += newPart;
        this.streamedLength = this.fullText.length;
        return newPart;
      }
      return "";
    }

    // 5. Nếu không khớp và text ngắn hơn (snapshot giữa chừng), tuyệt đối không ghi đè làm mất fullText
    return "";
  }

  finish(finalRawText?: string | null): { markdown: string; delta: string } {
    let delta = "";
    if (finalRawText) {
      delta = this.observe(finalRawText);
    }
    return {
      markdown: this.fullText,
      delta,
    };
  }

  getText(): string {
    return this.fullText;
  }
}
