import { stripOuterCodeFence } from "./strip-code-fence";

export { stripOuterCodeFence };

/**
 * Tìm độ dài đoạn giao thoa (overlap) giữa đuôi của existing và đầu của incoming.
 * Phục vụ cho cơ chế chống mất đầu khi trình duyệt kích hoạt DOM Virtualization (cuộn xuống đáy và unmount các dòng trên).
 */
export function findSuffixPrefixOverlap(
  existing: string,
  incoming: string,
  minOverlap = 10,
): number {
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
 * Bộ đệm phát dòng (Stream Buffer) cho Fast-Path.
 * Theo dõi chuỗi text đang sinh từ Editor và emit delta mới tăng dần.
 */
export class FastPathStreamBuffer {
  private streamedLength = 0;
  private fullText = "";

  observe(currentRawText?: string | null): string {
    const text = typeof currentRawText === "string" ? currentRawText : "";
    if (!text) return "";

    if (!this.fullText) {
      this.fullText = text;
      this.streamedLength = text.length;
      return text;
    }

    if (text.startsWith(this.fullText)) {
      const delta = text.slice(this.streamedLength);
      this.fullText = text;
      this.streamedLength = text.length;
      return delta;
    }

    if (
      this.fullText.length > 50 &&
      text.startsWith(this.fullText.slice(0, 50))
    ) {
      if (text.length > this.fullText.length) {
        const delta = text.slice(this.fullText.length);
        this.fullText = text;
        this.streamedLength = text.length;
        return delta;
      }
      return "";
    }

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

    return "";
  }

  finish(finalRawText?: string | null): { markdown: string; delta: string } {
    let delta = "";
    if (finalRawText) {
      delta = this.observe(finalRawText);
      if (finalRawText.length > this.fullText.length) {
        if (!delta) {
          delta = finalRawText.slice(this.streamedLength);
        }
        this.fullText = finalRawText;
        this.streamedLength = finalRawText.length;
      }
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
