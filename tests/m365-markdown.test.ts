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

  it("strictly preserves in-order blocks without omitting text or duplicating sections", () => {
    const buffer = new M365MarkdownBuffer();
    const emittedChunks: string[] = [];

    // Mô phỏng lượt sinh phức tạp gồm nhiều section có <br>, code block và danh sách
    // Nhịp 1: Section 5 với Entities và AssignData (chưa có AssignHistory)
    const step1Blocks: M365MarkdownBlock[] = [
      {
        key: "block-0-p",
        tag: "p",
        html: "<p>Pool Lead Domain<br>Entities:<br>PoolLead<br>PoolConfig<br>PoolUploadDataNote<br>AssignData<br>AssignHistory</p>",
        text: "Pool Lead Domain Entities: PoolLead PoolConfig PoolUploadDataNote AssignData AssignHistory",
        streamable: true,
      },
      {
        key: "block-1-p",
        tag: "p",
        html: "<p>Suy luận kiến trúc:<br>HTTP Request<br>      ↓<br>UserContextFilter<br>      ↓<br>CurrentUserInfo<br>      ↓<br>Business Service</p>",
        text: "Suy luận kiến trúc: HTTP Request ↓ UserContextFilter ↓ CurrentUserInfo ↓ Business Service",
        streamable: false, // Đang sinh dở dang
      },
    ];

    const chunk1 = buffer.observe(step1Blocks);
    if (chunk1) emittedChunks.push(chunk1);
    expect(chunk1).toContain("PoolLead");
    expect(chunk1).toContain("AssignHistory");
    expect(chunk1).not.toContain("Business Service"); // Khối 1 chưa streamable

    // Nhịp 2: Section 9 hoàn tất với Business Service và khối tiếp theo xuất hiện
    const step2Blocks: M365MarkdownBlock[] = [
      ...step1Blocks.slice(0, 1),
      {
        ...step1Blocks[1],
        streamable: true,
      },
      {
        key: "block-2-pre",
        tag: "pre",
        html: "<pre><code class=\"language-java\">log.info(\"request: {}\", request);</code></pre>",
        text: "log.info(\"request: {}\", request);",
        streamable: false,
      },
    ];

    const chunk2 = buffer.observe(step2Blocks);
    if (chunk2) emittedChunks.push(chunk2);
    expect(chunk2).toContain("Business Service");
    expect(chunk2).not.toContain("log.info"); // Khối code chưa streamable

    // Nhịp 3: Khối code hoàn tất, khối kết luận xuất hiện
    const step3Blocks: M365MarkdownBlock[] = [
      step2Blocks[0],
      step2Blocks[1],
      {
        ...step2Blocks[2],
        streamable: true,
      },
      {
        key: "block-3-p",
        tag: "p",
        html: "<p>16. Kiến trúc suy luận cuối cùng<br>Kết luận: monolithic domain service.</p>",
        text: "16. Kiến trúc suy luận cuối cùng Kết luận: monolithic domain service.",
        streamable: false,
      },
    ];

    const chunk3 = buffer.observe(step3Blocks);
    if (chunk3) emittedChunks.push(chunk3);
    expect(chunk3).toContain('log.info("request: {}", request);');

    // Nhịp 4: Kết thúc lượt
    const { delta: finalDelta, markdown: fullMd } = buffer.finish(step3Blocks);
    if (finalDelta) emittedChunks.push(finalDelta);

    expect(finalDelta).toContain("Kiến trúc suy luận cuối cùng");
    expect(fullMd).toContain("AssignHistory");
    expect(fullMd).toContain("Business Service");
    expect(fullMd).toContain('log.info("request: {}", request);');

    // Kiểm tra không bị duplicate khối code hay section 16 ở đuôi
    const occurrencesOfSection16 = (fullMd.match(/16[\\.]+\s*Kiến trúc suy luận cuối cùng/g) || []).length;
    expect(occurrencesOfSection16).toBe(1);

    const occurrencesOfAssignHistory = (fullMd.match(/AssignHistory/g) || []).length;
    expect(occurrencesOfAssignHistory).toBe(1);
  });
});
