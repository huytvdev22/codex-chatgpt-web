import { describe, expect, it } from "bun:test";
import { m365HtmlToMarkdown, M365MarkdownBuffer, type M365MarkdownBlock } from "../src/adapters/m365-copilot/markdown";

describe("m365HtmlToMarkdown", () => {
  it("strips thinking indicators from response start", () => {
    const html = "<p>Getting things ready… Đây là câu trả lời thực sự.</p>";
    const md = m365HtmlToMarkdown(html);
    expect(md).toBe("Đây là câu trả lời thực sự.");
  });

  it("strips Checking that now status phrase", () => {
    const html = "<p>Checking that now… Dưới đây là một chương trình <strong>Hello World</strong> đơn giản bằng Java</p>";
    const md = m365HtmlToMarkdown(html);
    expect(md).toBe("Dưới đây là một chương trình **Hello World** đơn giản bằng Java");
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

describe("M365MarkdownBuffer", () => {
  it("streams blocks sequentially without corrupting code blocks or prefix mismatch", () => {
    const buffer = new M365MarkdownBuffer();
    const emittedChunks: string[] = [];

    // Nhịp 1: Copilot sinh ra đoạn mở đầu, chưa có khối kế tiếp
    const step1Blocks: M365MarkdownBlock[] = [
      {
        key: "block-0-p",
        tag: "p",
        html: "<p>Dưới đây là một chương trình <strong>Hello World</strong> đơn giản bằng Java:</p>",
        text: "Dưới đây là một chương trình Hello World đơn giản bằng Java:",
        streamable: false,
      }
    ];
    const chunk1 = buffer.observe(step1Blocks);
    if (chunk1) emittedChunks.push(chunk1);
    expect(chunk1).toBe(""); // Chưa có khối kế tiếp nên chưa emit

    // Nhịp 2: Khối code block bắt đầu xuất hiện, khối mở đầu hoàn tất
    const step2Blocks: M365MarkdownBlock[] = [
      {
        key: "block-0-p",
        tag: "p",
        html: "<p>Dưới đây là một chương trình <strong>Hello World</strong> đơn giản bằng Java:</p>",
        text: "Dưới đây là một chương trình Hello World đơn giản bằng Java:",
        streamable: true,
      },
      {
        key: "block-1-pre",
        tag: "pre",
        html: `<pre><code class="language-java">public class HelloWorld {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}</code></pre>`,
        text: "public class HelloWorld...",
        streamable: false, // Code block đang là khối cuối cùng, chưa streamable
      }
    ];
    const chunk2 = buffer.observe(step2Blocks);
    if (chunk2) emittedChunks.push(chunk2);
    expect(chunk2).toBe("Dưới đây là một chương trình **Hello World** đơn giản bằng Java:");

    // Nhịp 3: Khối tiêu đề kế tiếp xuất hiện, code block hoàn tất 100%
    const step3Blocks: M365MarkdownBlock[] = [
      {
        key: "block-0-p",
        tag: "p",
        html: "<p>Dưới đây là một chương trình <strong>Hello World</strong> đơn giản bằng Java:</p>",
        text: "Dưới đây là một chương trình Hello World đơn giản bằng Java:",
        streamable: true,
      },
      {
        key: "block-1-pre",
        tag: "pre",
        html: `<pre><code class="language-java">public class HelloWorld {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}</code></pre>`,
        text: "public class HelloWorld...",
        streamable: true, // Đã có khối kế tiếp -> streamable!
      },
      {
        key: "block-2-h2",
        tag: "h2",
        html: "<h2>Giải thích</h2>",
        text: "Giải thích",
        streamable: false,
      }
    ];
    const chunk3 = buffer.observe(step3Blocks);
    if (chunk3) emittedChunks.push(chunk3);

    // Kiểm tra code block được emit trọn vẹn, không có dấu ``` vụn vặt ở giữa
    expect(chunk3).toContain("```java\npublic class HelloWorld {");
    expect(chunk3).toContain('System.out.println("Hello, World!");');
    expect(chunk3).toContain("}\n```");

    // Nhịp 4: Copilot hoàn tất lượt sinh
    const { delta: finalDelta, markdown: fullMd } = buffer.finish();
    if (finalDelta) emittedChunks.push(finalDelta);

    expect(finalDelta).toBe("\n\n## Giải thích");
    expect(fullMd).toBe(emittedChunks.join(""));
    expect(fullMd).not.toContain("```;");
  });
});
