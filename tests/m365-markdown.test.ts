import { describe, expect, it } from "bun:test";
import { m365HtmlToMarkdown } from "../src/adapters/m365-copilot/markdown";

describe("m365HtmlToMarkdown", () => {
  it("strips thinking indicators from response start", () => {
    const html = "<p>Getting things ready… Đây là câu trả lời thực sự.</p>";
    const md = m365HtmlToMarkdown(html);
    expect(md).toBe("Đây là câu trả lời thực sự.");
  });

  it("strips Vietnamese thinking phrases", () => {
    const html = "<p>Đang chuẩn bị… Đây là kết quả phân tích.</p>";
    const md = m365HtmlToMarkdown(html);
    expect(md).toBe("Đây là kết quả phân tích.");
  });

  it("strips Copilot prefix", () => {
    const html = "<p>Copilot said: Mã nguồn của file như sau:</p>";
    const md = m365HtmlToMarkdown(html);
    expect(md).toBe("Mã nguồn của file như sau:");
  });

  it("strips Taking a look status phrase", () => {
    const html = "<p>Taking a look… Dưới đây là chương trình Java HelloWorld.</p>";
    const md = m365HtmlToMarkdown(html);
    expect(md).toBe("Dưới đây là chương trình Java HelloWorld.");
  });

  it("strips Copilot said combined with Taking a look status", () => {
    const html = "<p>Copilot said: Taking a look… Đây là kết quả.</p>";
    const md = m365HtmlToMarkdown(html);
    expect(md).toBe("Đây là kết quả.");
  });

  it("formats code blocks with syntax highlighting", () => {
    const html = `<pre><code class="language-typescript">const x: number = 42;\nconsole.log(x);</code></pre>`;
    const md = m365HtmlToMarkdown(html);
    expect(md).toContain("```typescript");
    expect(md).toContain('const x: number = 42;');
    expect(md).toContain("```");
  });
});
