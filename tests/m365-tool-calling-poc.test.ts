import { describe, expect, test } from "bun:test";
import { compileM365Prompt, compileM365HybridForwardPrompt, truncateToolResult } from "../src/adapters/m365-copilot/prompt";
import { M365ToolCallDetector, M365MarkdownBuffer, normalizeMarkdownFences } from "../src/adapters/m365-copilot/markdown";
import { M365ToolBridge, normalizeFileContent } from "../src/adapters/m365-copilot/tool-bridge";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

describe("M365 Tool Calling PoC Tests", () => {
  test("Phase 3: compileM365Prompt injects read_file declaration on new conversation", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/default",
      stream: true,
      context: {
        messages: [{
          role: "user",
          content: "Read pom.xml",
          timestamp: Date.now(),
        }],
      },
      options: {},
    };

    const prompt = compileM365Prompt(parsed, true);
    expect(prompt).toContain("read_file(path");
    expect(prompt).toContain("<tool_call>");
    expect(prompt).toContain("</tool_call>");
    expect(prompt).toContain("Read pom.xml");
  });

  test("Phase 4: M365ToolCallDetector parses partial streaming chunks and suppresses tool xml", () => {
    const detector = new M365ToolCallDetector();
    const chunks = [
      "Tôi sẽ kiểm tra file pom.xml cho bạn.\n<tool",
      "_call>\n",
      "{\n  \"name\": \"read_file\",\n  \"arguments\": {\n    \"path\": \"pom.xml\"\n  }\n}",
      "\n</tool_call>\n"
    ];

    const emitted: string[] = [];
    for (const chunk of chunks) {
      const text = detector.feed(chunk);
      if (text) emitted.push(text);
    }
    const { remainingText, toolCall } = detector.finish();
    if (remainingText) emitted.push(remainingText);

    expect(detector.hasDetectedToolCall()).toBeTrue();
    expect(toolCall).not.toBeNull();
    expect(toolCall?.name).toBe("read_file");
    expect(toolCall?.arguments).toEqual({ path: "pom.xml" });

    // Không làm rò rỉ cú pháp tool call ra ngoài text streaming
    const fullEmittedText = emitted.join("");
    expect(fullEmittedText).not.toContain("<tool_call>");
    expect(fullEmittedText).not.toContain("</tool_call>");
    expect(fullEmittedText).toContain("Tôi sẽ kiểm tra file pom.xml cho bạn.\n");
  });

  test("Phase 4: M365ToolCallDetector unescapes Turndown escaped markdown (\\_ to _)", () => {
    const detector = new M365ToolCallDetector();
    const rawTurndownOutput = "<tool\\_call>\n```json\n{\n  \"name\": \"read\\_file\",\n  \"arguments\": {\n    \"path\": \"pom.xml\"\n  }\n}\n```\n</tool\\_call>";
    detector.feed(rawTurndownOutput);
    detector.finish();

    expect(detector.hasDetectedToolCall()).toBeTrue();
    const toolCall = detector.getToolCall();
    expect(toolCall?.name).toBe("read_file");
    expect(toolCall?.arguments).toEqual({ path: "pom.xml" });
  });

  test("Phase 5 & Bridge verification: M365 tool events pass through bridge.ts correctly", async () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_test_123", name: "read_file" },
      { type: "tool_call_delta", arguments: JSON.stringify({ path: "pom.xml" }) },
      { type: "tool_call_end" },
      {
        type: "done",
        stopReason: "tool_use",
        endTurn: false,
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      },
    ];

    // Kiểm tra cấu trúc JSON từ buildResponseJSON
    const json = buildResponseJSON(events, "m365-copilot/default") as {
      status: string;
      end_turn: boolean;
      output: Array<Record<string, unknown>>;
    };

    expect(json.status).toBe("completed");
    expect(json.end_turn).toBeFalse();
    expect(json.output.length).toBeGreaterThan(0);
    const fcItem = json.output.find(item => item.type === "function_call");
    expect(fcItem).toBeDefined();
    expect(fcItem?.name).toBe("read_file");
    expect(fcItem?.call_id).toBe("call_test_123");
    expect(fcItem?.arguments).toBe(JSON.stringify({ path: "pom.xml" }));

    // Kiểm tra luồng SSE stream từ bridgeToResponsesSSE
    async function* gen(): AsyncGenerator<AdapterEvent> {
      yield* events;
    }
    const stream = bridgeToResponsesSSE(gen(), "m365-copilot/default");
    const response = new Response(stream);
    const sseText = await response.text();

    expect(sseText).toContain("event: response.output_item.added");
    expect(sseText).toContain('"type":"function_call"');
    expect(sseText).toContain('"name":"read_file"');
    expect(sseText).toContain("event: response.function_call_arguments.delta");
    expect(sseText).toContain("event: response.function_call_arguments.done");
    expect(sseText).toContain("event: response.output_item.done");
    expect(sseText).toContain("event: response.completed");
    expect(sseText).toContain('"end_turn":false');
  });

  test("Phase 6: compileM365Prompt formats toolResult into <tool_result> for next turn", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/default",
      stream: true,
      context: {
        messages: [
          {
            role: "user",
            content: "Read pom.xml",
            timestamp: Date.now() - 2000,
          },
          {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "call_test_123",
              name: "read_file",
              arguments: { path: "pom.xml" },
            }],
            model: "m365-copilot/default",
            timestamp: Date.now() - 1000,
          },
          {
            role: "toolResult",
            toolCallId: "call_test_123",
            toolName: "read_file",
            content: "<project><modelVersion>4.0.0</modelVersion></project>",
            isError: false,
            timestamp: Date.now(),
          },
        ],
      },
      options: {},
    };

    // Khi không phải new conversation (roundtrip turn)
    const prompt = compileM365Prompt(parsed, false);
    expect(prompt).toContain("<tool_result>");
    expect(prompt).toContain("<project><modelVersion>4.0.0</modelVersion></project>");
    expect(prompt).toContain("</tool_result>");
  });

  test("Phase 1 Expansion: truncateToolResult safeguards large tool payloads", () => {
    // 1. Text ngắn: Giữ nguyên
    const shortText = "Short tool output within limit";
    expect(truncateToolResult(shortText)).toBe(shortText);

    // 2. Text siêu dài (20,000 ký tự): Cắt ngắn an toàn
    const longText = "A".repeat(10_000) + "MIDDLE_SECRET" + "Z".repeat(10_000);
    const truncated = truncateToolResult(longText, 8000);

    expect(truncated.length).toBeLessThan(8200);
    expect(truncated).toContain("Đã lược bớt");
    expect(truncated.startsWith("AAAA")).toBeTrue();
    expect(truncated.endsWith("ZZZZ")).toBeTrue();
    expect(truncated).not.toContain("MIDDLE_SECRET");
  });

  test("Phase 2 Expansion: M365ToolBridge maps all inspection & mutation tools with PosixCommandStrategy and PowerShellCommandStrategy", async () => {
    const { M365ToolBridge, PosixCommandStrategy, PowerShellCommandStrategy, CommandStrategyResolver } = await import("../src/adapters/m365-copilot/tool-bridge");
    const posix = new PosixCommandStrategy();
    const ps = new PowerShellCommandStrategy();

    // --- KIỂM TRA POSIX / NODE RUNNER (macOS, Linux) ---
    // 1. read_file: dùng node -e
    const r1 = M365ToolBridge.mapToolCall({ name: "read_file", arguments: { path: "src/main.ts" } }, [], posix);
    expect(r1.name).toBe("exec_command");
    expect(JSON.parse(r1.arguments).cmd).toContain('node -e "const fs=require(\'fs\')');
    expect(JSON.parse(r1.arguments).cmd).toContain('"src/main.ts"');

    // 2. list_dir: dùng node -e
    const r2 = M365ToolBridge.mapToolCall({ name: "list_dir", arguments: { path: "src" } }, [], posix);
    expect(r2.name).toBe("exec_command");
    expect(JSON.parse(r2.arguments).cmd).toContain('node -e "const fs=require(\'fs\')');
    expect(JSON.parse(r2.arguments).cmd).toContain('"src"');

    // 3. search_files: dùng node -e
    const r3 = M365ToolBridge.mapToolCall({ name: "search_files", arguments: { pattern: "*.json" } }, [], posix);
    expect(r3.name).toBe("exec_command");
    expect(JSON.parse(r3.arguments).cmd).toContain("node -e");
    expect(JSON.parse(r3.arguments).cmd).toContain('"*.json"');

    // 4. grep_code: dùng node -e
    const r4 = M365ToolBridge.mapToolCall({ name: "grep_code", arguments: { query: "compileM365Prompt" } }, [], posix);
    expect(r4.name).toBe("exec_command");
    expect(JSON.parse(r4.arguments).cmd).toContain("node -e");
    expect(JSON.parse(r4.arguments).cmd).toContain('"compileM365Prompt"');

    // 5. git_status
    const r5 = M365ToolBridge.mapToolCall({ name: "git_status", arguments: {} }, [], posix);
    expect(r5.name).toBe("exec_command");
    expect(JSON.parse(r5.arguments).cmd).toBe("git status -s");

    // 6. git_diff
    const r6 = M365ToolBridge.mapToolCall({ name: "git_diff", arguments: { path: "package.json" } }, [], posix);
    expect(r6.name).toBe("exec_command");
    expect(JSON.parse(r6.arguments).cmd).toBe('git diff "package.json"');

    // 7. run_command
    const r7 = M365ToolBridge.mapToolCall({ name: "run_command", arguments: { cmd: "bun test" } }, [], posix);
    expect(r7.name).toBe("exec_command");
    expect(JSON.parse(r7.arguments).cmd).toBe("bun test");

    // 8. write_file với Base64
    const r8 = M365ToolBridge.mapToolCall({
      name: "write_file",
      arguments: { path: "demo.txt", content: "console.log('hello');" },
    }, [], posix);
    expect(r8.name).toBe("exec_command");
    const parsedCmd = JSON.parse(r8.arguments).cmd;
    expect(parsedCmd).toContain("node -e");
    expect(parsedCmd).toContain('"demo.txt"');
    const expectedB64 = Buffer.from("console.log('hello');").toString("base64");
    expect(parsedCmd).toContain(expectedB64);

    // --- KIỂM TRA NATIVE POWERSHELL RUNNER (Windows độc lập không cần Node.js) ---
    const psRead = M365ToolBridge.mapToolCall({ name: "read_file", arguments: { path: "demo.java" } }, [], ps);
    expect(psRead.name).toBe("exec_command");
    const psReadCmd = JSON.parse(psRead.arguments).cmd;
    expect(psReadCmd).toContain("powershell -NoProfile -EncodedCommand ");

    const psWrite = M365ToolBridge.mapToolCall({ name: "write_file", arguments: { path: "demo.txt", content: "Hello PS" } }, [], ps);
    expect(psWrite.name).toBe("exec_command");
    const psWriteCmd = JSON.parse(psWrite.arguments).cmd;
    expect(psWriteCmd).toContain("powershell -NoProfile -EncodedCommand ");

    // --- KIỂM TRA RESOLVER THEO SHELL / PLATFORM ---
    const resolvedPs = CommandStrategyResolver.resolve({ shell: "powershell" });
    expect(resolvedPs.platformName).toBe("powershell");
    const resolvedBash = CommandStrategyResolver.resolve({ shell: "bash" });
    expect(resolvedBash.platformName).toBe("posix");
  });

  test("Phase 7: compileM365Prompt includes neutral protocol specification, multi-step rules, and end-of-prompt formatting directive", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/default",
      stream: true,
      context: {
        messages: [{
          role: "user",
          content: "# Context from my IDE setup:\n## Active file: server.js\n\nkiểm tra cú pháp file sau đó run server lên rồi test cho tôi",
          timestamp: Date.now(),
        }],
      },
      options: {},
    };

    const prompt = compileM365Prompt(parsed, true);
    expect(prompt).toContain("QUY TẮC ĐỊNH DẠNG ĐẦU RA");
    expect(prompt).toContain("write_file");
    expect(prompt).toContain("MULTI-STEP");
    expect(prompt).toContain("node --check server.js");
    expect(prompt).toContain("/mnt/data");
    expect(prompt).toContain("[Yêu cầu định dạng đầu ra]");
    expect(prompt.endsWith("hoặc tự chạy trong sandbox /mnt/data.")).toBeTrue();
  });

  test("Phase 8: M365ToolCallDetector parses raw multiline unescaped newlines in JSON string literals (Self-healing parser)", () => {
    const detector = new M365ToolCallDetector();
    // Payload thực tế từ Copilot với dấu ENTER xuống dòng thật bên trong chuỗi content
    const rawCopilotPayload = `<tool_call> { "name": "write_file", "arguments": { "path": "server.js", "content": "const http = require('http');\n\nconst PORT = process.env.PORT || 3000;\n\nconst server = http.createServer(function(req, res) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'Hello from Node.js server' })); });\n\nserver.listen(PORT, function() { console.log('Server is running on port ' + PORT); });" } } </tool_call>`;

    detector.feed(rawCopilotPayload);
    const { toolCall } = detector.finish();

    expect(detector.hasDetectedToolCall()).toBeTrue();
    expect(toolCall).not.toBeNull();
    expect(toolCall?.name).toBe("write_file");
    const args = toolCall?.arguments as Record<string, any>;
    expect(args.path).toBe("server.js");
    expect(args.content).toContain("const http = require('http');");
    expect(args.content).toContain("server.listen(PORT");
    expect(args.content.split("\n").length).toBeGreaterThan(1);
  });

  test("Phase 8: M365ToolBridge automatically unescapes literal \\n in single-line write_file payload", async () => {
    const { PosixCommandStrategy } = await import("../src/adapters/m365-copilot/tool-bridge");
    const singleLineEscaped = "const http = require('http');\\nconst PORT = 3000;\\nconsole.log(PORT);";
    const mapped = M365ToolBridge.mapToolCall({
      name: "write_file",
      arguments: { path: "server.js", content: singleLineEscaped },
    }, [], new PosixCommandStrategy());

    const parsedArgs = JSON.parse(mapped.arguments);
    const match = parsedArgs.cmd.match(/node -e "[^"]+"\s+"[^"]+"\s+"([^"]+)"/);
    expect(match).not.toBeNull();
    const base64Decoded = Buffer.from(match[1], "base64").toString("utf8");
    // Phải được unescape thành các dòng mới thực tế
    expect(base64Decoded).toContain("\n");
    expect(base64Decoded.split("\n").length).toBe(3);
  });

  test("Phase 9: normalizeFileContent handles byte 5c 0a (trailing backslash), Turndown \\*, and unescapeNewlines flag", async () => {
    const { PosixCommandStrategy } = await import("../src/adapters/m365-copilot/tool-bridge");

    // 1. Khử trailing backslash trước newline (\ + newline, byte 5c 0a)
    const trailingSlashCode = "function add(a, b) { return a + b; }\\\nfunction sub(a, b) { return a - b; }";
    const cleanedSlash = normalizeFileContent(trailingSlashCode);
    expect(cleanedSlash).toBe("function add(a, b) { return a + b; }\nfunction sub(a, b) { return a - b; }");

    // 2. Khử Turndown markdown escape cho phép toán \*
    const mathCode = "function multiply(a, b) { return a \\* b; }";
    const cleanedMath = normalizeFileContent(mathCode);
    expect(cleanedMath).toBe("function multiply(a, b) { return a * b; }");

    // 3. Tôn trọng cờ unescapeNewlines = false
    const rawLiteral = "line1\\nline2";
    const preserved = normalizeFileContent(rawLiteral, false);
    expect(preserved).toBe("line1\\nline2");

    // 4. M365ToolBridge tôn trọng unescape_newlines: false từ AI
    const mappedRaw = M365ToolBridge.mapToolCall({
      name: "write_file",
      arguments: { path: "raw.txt", content: "raw\\ntext", unescape_newlines: false },
    }, [], new PosixCommandStrategy());
    const parsedRaw = JSON.parse(mappedRaw.arguments);
    const match = parsedRaw.cmd.match(/node -e "[^"]+"\s+"[^"]+"\s+"([^"]+)"/);
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    expect(decoded).toBe("raw\\ntext");
  });

  test("Phase 10: M365ToolBridge maps read_file with start_line and end_line parameters", async () => {
    const { PosixCommandStrategy } = await import("../src/adapters/m365-copilot/tool-bridge");
    const mapped = M365ToolBridge.mapToolCall({
      name: "read_file",
      arguments: { path: "server.js", start_line: 15, end_line: 45 },
    }, [], new PosixCommandStrategy());

    expect(mapped.name).toBe("exec_command");
    const cmd = JSON.parse(mapped.arguments).cmd;
    expect(cmd).toContain('"server.js"');
    expect(cmd).toContain('15 45');
    expect(cmd).toContain('lines.slice');
  });

  test("Phase 11: normalizeFileContent eliminates trailing backslashes, empty-line slashes, and unescapes Turndown brackets/braces", () => {
    // Đoạn code thực tế bị lỗi cú pháp như trong ảnh của người dùng (chứa \\ cuối dòng, dòng rỗng \\, \\[\\] và \\{\\)
    const buggySource = [
      "const { EventEmitter } = require('events');\\",
      "\\",
      "const TASK_STATUS = {\\",
      "  PENDING: 'PENDING',\\",
      "  RUNNING: 'RUNNING',\\",
      "  COMPLETED: 'COMPLETED',\\",
      "  FAILED: 'FAILED'\\",
      "};\\",
      "\\",
      "function calculateBackoffDelay(attempt, baseDelay = 500, maxDelay = 30000) {\\",
      "  const exponentialDelay = Math.min(baseDelay * (2 ** attempt), maxDelay);\\",
      "  const jitter = Math.floor(Math.random() * (exponentialDelay * 0.2));\\",
      "  return exponentialDelay + jitter;\\",
      "}\\",
      "\\",
      "class TaskQueue extends EventEmitter {\\",
      "  constructor(options = {}) {\\",
      "    super();\\",
      "    this.concurrency = options.concurrency || 3;\\",
      "    this.queue = \\[\\];\\",
      "    this.metrics = \\{\\",
      "      completed: 0\\",
      "    };\\",
      "  }\\",
      "}\\",
      "module.exports = { TaskQueue };"
    ].join("\n");

    const cleaned = normalizeFileContent(buggySource);

    // Không còn dấu gạch chéo ngược ở cuối dòng
    expect(cleaned).not.toMatch(/\\+\s*(\r?\n|$)/m);
    // Không còn dấu ngoặc vuông bị escape
    expect(cleaned).toContain("this.queue = [];");
    // Không còn dấu ngoặc nhọn bị escape
    expect(cleaned).toContain("this.metrics = {");
    // Giữ nguyên dòng trống tự nhiên
    expect(cleaned).toContain("require('events');\n\nconst TASK_STATUS");

    // Kiểm tra tính hợp lệ cú pháp JavaScript bằng new Function()
    expect(() => new Function(cleaned)).not.toThrow();
  });

  test("Phase 11: M365ToolCallDetector parses payload with escaped brackets and trailing backslash", () => {
    const detector = new M365ToolCallDetector();
    const rawPayload = `<tool\\_call>
{
  "name": "write\\_file",
  "arguments": {
    "path": "task-queue.js",
    "content": "const a = \\[\\];\\
const b = \\{\\
  val: 1\\
};",
    "unescape_newlines": true
  }
}
</tool\\_call>`;

    detector.feed(rawPayload);
    const { toolCall } = detector.finish();

    expect(detector.hasDetectedToolCall()).toBeTrue();
    expect(toolCall).not.toBeNull();
    expect(toolCall?.name).toBe("write_file");
    const args = toolCall?.arguments as Record<string, any>;
    expect(args.path).toBe("task-queue.js");

    const cleanedContent = normalizeFileContent(args.content);
    expect(cleanedContent).toContain("const a = [];");
    expect(cleanedContent).toContain("const b = {");
    expect(() => new Function(cleanedContent)).not.toThrow();
  });

  test("Phase 12: PlatformCommandStrategy - PowerShellCommandStrategy executes natively on Windows", async () => {
    const { PowerShellCommandStrategy, CommandStrategyResolver } = await import("../src/adapters/m365-copilot/tool-bridge");
    const { execSync } = await import("child_process");

    const psStrategy = new PowerShellCommandStrategy();
    expect(psStrategy.platformName).toBe("powershell");

    // 1. Kiểm tra lệnh đọc file thật trên Windows
    const readCmd = psStrategy.readFile("package.json", { startLine: 1, endLine: 3 });
    expect(readCmd).toContain("powershell -NoProfile -EncodedCommand ");
    
    // Thực thi qua PowerShell nếu môi trường có powershell (ví dụ Windows hoặc máy có pwsh)
    if (process.platform === "win32") {
      const readOutput = execSync(readCmd, { encoding: "utf8" });
      expect(readOutput).toContain("[File: package.json (1-3/");
      expect(readOutput).toContain("1: {");
      expect(readOutput).toContain('"name": "codex-chatgpt-web"');

      // 2. Kiểm tra lệnh liệt kê thư mục thật trên Windows
      const listCmd = psStrategy.listDir("src/adapters/m365-copilot");
      const listOutput = execSync(listCmd, { encoding: "utf8" });
      expect(listOutput).toContain("tool-bridge.ts");
      expect(listOutput).toContain("strategies/");
    } else {
      // Trên POSIX (mac/linux), kiểm tra định dạng base64 EncodedCommand
      const base64Part = readCmd.split("-EncodedCommand ")[1].trim();
      const decodedScript = Buffer.from(base64Part, "base64").toString("utf16le");
      expect(decodedScript).toContain("$lines = [System.IO.File]::ReadAllLines");
      expect(decodedScript).toContain("cGFja2FnZS5qc29u");

      const listCmd = psStrategy.listDir("src/adapters/m365-copilot");
      const listBase64 = listCmd.split("-EncodedCommand ")[1].trim();
      const decodedListScript = Buffer.from(listBase64, "base64").toString("utf16le");
      expect(decodedListScript).toContain("Get-ChildItem -LiteralPath");
    }

    // 3. Kiểm tra Resolver tự động phát hiện đúng strategy
    const pwshStrategy = CommandStrategyResolver.resolve({ shell: "pwsh" });
    expect(pwshStrategy.platformName).toBe("powershell");

    const zshStrategy = CommandStrategyResolver.resolve({ shell: "zsh" });
    expect(zshStrategy.platformName).toBe("posix");

    const winStrategy = CommandStrategyResolver.resolve({ platform: "win32" });
    expect(winStrategy.platformName).toBe("powershell");

    const macStrategy = CommandStrategyResolver.resolve({ platform: "darwin" });
    expect(macStrategy.platformName).toBe("posix");
  });
  test("Phase 13: M365 Output Stream Hardening - Fixes drop token, duplicate headings, and malformed fences", () => {
    // 1. Kiểm tra normalizeMarkdownFences sửa chữa các code fence bị cụt 2 backtick hoặc lẻ 1 backtick
    const malformed1 = ["split_tabs_meta_*", "``"].join("\n");
    expect(normalizeMarkdownFences(malformed1)).toBe("split_tabs_meta_*\n```");

    const malformed2 = ["``javascript", "schemaVersion", "migration", "``"].join("\n");
    expect(normalizeMarkdownFences(malformed2)).toBe("```javascript\nschemaVersion\nmigration\n```");

    const malformed3 = ["Launch next task", "`"].join("\n");
    expect(normalizeMarkdownFences(malformed3)).toBe("Launch next task\n```");

    // 2. Kiểm tra M365MarkdownBuffer không bị lặp tiêu đề dù index thay đổi giữa các nhịp stream
    const buffer = new M365MarkdownBuffer();

    // Nhịp 1: Stream block 0 (intro) và block 1 (heading)
    const nhip1 = [
      { key: "p::Intro#1", tag: "p", html: "<p>Intro</p>", text: "Intro", streamable: true },
      { key: "h1::Parallel_Engine#1", tag: "h1", html: "<h1>Parallel Engine</h1>", text: "Parallel Engine", streamable: true },
      { key: "p::Loading#1", tag: "p", html: "<p>Loading...</p>", text: "Loading...", streamable: false }
    ];
    const delta1 = buffer.observe(nhip1);
    expect(delta1).toContain("Intro");
    expect(delta1).toContain("# Parallel Engine");

    // Nhịp 2: Block Intro bị DOM dọn rác, heading bị đẩy lên đầu (nhưng cùng key signature)
    const nhip2 = [
      { key: "h1::Parallel_Engine#1", tag: "h1", html: "<h1>Parallel Engine</h1>", text: "Parallel Engine", streamable: true },
      { key: "p::Subsystem#1", tag: "p", html: "<p>Subsystem info</p>", text: "Subsystem info", streamable: true },
      { key: "p::Next#1", tag: "p", html: "<p>Next...</p>", text: "Next...", streamable: false }
    ];
    const delta2 = buffer.observe(nhip2);
    // Tuyệt đối KHÔNG được lặp lại "# Parallel Engine"
    expect(delta2).not.toContain("Parallel Engine");
    expect(delta2).toContain("Subsystem info");

    // 3. Kiểm tra M365MarkdownBuffer không bị nuốt token ngắn khi mảng block bị co lại
    const nhip3 = [
      { key: "h1::Parallel_Engine#1", tag: "h1", html: "<h1>Parallel Engine</h1>", text: "Parallel Engine", streamable: true },
      { key: "p::Subsystem#1", tag: "p", html: "<p>Subsystem info</p>", text: "Subsystem info", streamable: true },
      { key: "p::Wrapper#1", tag: "p", html: "<p>Wrapper cho:</p>", text: "Wrapper cho:", streamable: true },
      { key: "code::chrome.storage.local#1", tag: "pre", html: "<pre><code>chrome.storage.local</code></pre>", text: "chrome.storage.local", streamable: true },
      { key: "p::Correct#1", tag: "p", html: "<p>Đúng hướng.</p>", text: "Đúng hướng.", streamable: true }
    ];
    const finalResult = buffer.finish(nhip3);
    expect(finalResult.markdown).toContain("chrome.storage.local");
    expect(finalResult.markdown).toContain("Đúng hướng.");
    expect(finalResult.delta).toContain("chrome.storage.local");
  });

  test("Phase 14: compileM365HybridForwardPrompt combines protocol directive and raw codex json without coercive output format directive", () => {
    const parsed: CodexParsedRequest = {
      modelId: "m365-copilot/think",
      stream: true,
      context: {
        messages: [{
          role: "user",
          content: "chỉnh sửa và thêm comment cho file này giúp tôi",
          timestamp: Date.now(),
        }],
      },
      options: {},
    };
    const rawBody = {
      model: "m365-copilot/think",
      input: [{ role: "user", content: "chỉnh sửa file" }],
    };

    const prompt = compileM365HybridForwardPrompt(parsed, rawBody);
    expect(prompt).toContain("TEXT INTERACTION PROTOCOL");
    expect(prompt).toContain("sandbox /mnt/data");
    expect(prompt).toContain("<tool_call>");
    expect(prompt).toContain("<custom_tool_call");
    expect(prompt).toContain("[YÊU CẦU CỦA NGƯỜI DÙNG]");
    expect(prompt).toContain("chỉnh sửa file");
    // Khẳng định loại bỏ hoàn toàn dòng lệnh ép buộc tool call
    expect(prompt).not.toContain("[Yêu cầu định dạng đầu ra]");
  });

  test("Phase 15: M365OutputTranslator cleans user raw response with unescaped quotes, 2-star End Patch, and BizChat suffix", () => {
    const { M365OutputTranslator } = require("../src/adapters/m365-copilot/output-translator");
    const rawUserSnippet = `<tool_call> {"name":"apply_patch","arguments":{"patch":"*** Begin Patch\\n*** Update File: .github/workflows/ci.yml\\n@@\\n if (-not :Is64BitOperatingSystem) {\\n throw \\"The Windows CI runner must be 64-bit\\"\\n }\\n** End Patch"}} </tool_call>\\n\\nProvide your feedback on BizChat`;

    const translator = new M365OutputTranslator();
    const result = translator.translate(rawUserSnippet);

    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.tool_calls.length).toBe(1);
      const call = result.tool_calls[0];
      expect(call.function.name).toBe("apply_patch");
      const args = JSON.parse(call.function.arguments);
      expect(args.input).toContain("*** Begin Patch");
      expect(args.input).toContain("*** End Patch");
      expect(args.input).toContain("throw \"The Windows CI runner must be 64-bit\"");
      expect(args.input).not.toContain("BizChat");
      expect(args.input).not.toContain("}} </tool_call>");
      expect(args.input.endsWith("*** End Patch")).toBe(true);
    }
  });

  test("Phase 15b: M365OutputTranslator translates custom_tool_call name=apply_patch cleanly", () => {
    const { M365OutputTranslator } = require("../src/adapters/m365-copilot/output-translator");
    const rawSnippet = `<custom_tool_call name="apply_patch">\n*** Begin Patch\n*** Update File: test.txt\n@@\n-old\n+new\n*** End Patch\n</custom_tool_call>`;

    const translator = new M365OutputTranslator();
    const result = translator.translate(rawSnippet);

    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.tool_calls.length).toBe(1);
      const call = result.tool_calls[0];
      expect(call.function.name).toBe("apply_patch");
      const args = JSON.parse(call.function.arguments);
      expect(args.input).toContain("*** Begin Patch");
      expect(args.input).toContain("*** End Patch");
      expect(args.input.endsWith("*** End Patch")).toBe(true);
    }
  });

  test("Phase 15c: Natural conversational greeting translates to final_answer without false-positive tool call", () => {
    const { M365OutputTranslator } = require("../src/adapters/m365-copilot/output-translator");
    const naturalReply = "Xin chào! Tôi là Trợ lý lập trình AI của bạn. Tôi có thể giúp gì cho dự án hôm nay?";

    const translator = new M365OutputTranslator();
    const result = translator.translate(naturalReply);

    expect(result.type).toBe("final_answer");
    if (result.type === "final_answer") {
      expect(result.content).toBe(naturalReply);
    }
  });
});

