import { normalizeMarkdownFences, m365HtmlToMarkdown } from "./html-to-markdown";
import { SemanticMarkdownBuffer, type SemanticMarkdownBlock } from "../../base-web/translation";

export { m365HtmlToMarkdown };

export type M365MarkdownBlock = SemanticMarkdownBlock;

/**
 * M365MarkdownBuffer kế thừa SemanticMarkdownBuffer và sử dụng bộ chuyển đổi m365HtmlToMarkdown
 */
export class M365MarkdownBuffer extends SemanticMarkdownBuffer {
  constructor(transform: (md: string) => string = md => md) {
    super(m365HtmlToMarkdown, (md) => normalizeMarkdownFences(transform(md)));
  }
}
