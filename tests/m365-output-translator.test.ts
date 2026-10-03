import { describe, expect, test } from "bun:test";
import {
  M365OutputTranslator,
  JsonToolCallDetector,
  XmlToolCallDetector,
  BashCommandDetector,
  stripShellPrefix,
  BashCommandTranslator,
  M365AgentLoop,
  type IM365ModelClient,
  type IToolExecutor,
} from "../src/adapters/m365-copilot";

describe("M365 Output Translator Specification Tests", () => {
  const translator = new M365OutputTranslator();

  // ==========================================
  // CASE 1: XML Tool Call
  // ==========================================
  test("CASE 1: XML Tool Call -> OpenAI Tool Call", () => {
    const input = `<tool_call>
{
  "name":"read_file",
  "arguments":{
    "path":"pom.xml"
  }
}
</tool_call>`;

    const result = translator.translate(input);
    expect(result.type).toBe("tool_call");

    if (result.type === "tool_call") {
      expect(result.tool_calls.length).toBe(1);
      const call = result.tool_calls[0];
      expect(call.type).toBe("function");
      expect(call.id).toMatch(/^call_/);
      expect(call.function.name).toBe("read_file");
      expect(JSON.parse(call.function.arguments)).toEqual({ path: "pom.xml" });
    }
  });

  test("CASE 1 (Biến thể Turndown Markdown): <tool\\_call> với code block json", () => {
    const input = `<tool\\_call>
\`\`\`json
{
  "name": "read\\_file",
  "arguments": {
    "path": "pom.xml"
  }
}
\`\`\`
</tool\\_call>`;

    const result = translator.translate(input);
    expect(result.type).toBe("tool_call");

    if (result.type === "tool_call") {
      const call = result.tool_calls[0];
      expect(call.function.name).toBe("read_file");
      expect(JSON.parse(call.function.arguments)).toEqual({ path: "pom.xml" });
    }
  });

  // ==========================================
  // CASE 2: JSON Tool Call
  // ==========================================
  test("CASE 2: JSON Tool Call -> OpenAI Tool Call", () => {
    const input = `{
  "action":"tool_call",
  "tool":"read_file",
  "arguments":{
    "path":"pom.xml"
  }
}`;

    const result = translator.translate(input);
    expect(result.type).toBe("tool_call");

    if (result.type === "tool_call") {
      expect(result.tool_calls.length).toBe(1);
      const call = result.tool_calls[0];
      expect(call.type).toBe("function");
      expect(call.id).toMatch(/^call_/);
      expect(call.function.name).toBe("read_file");
      expect(JSON.parse(call.function.arguments)).toEqual({ path: "pom.xml" });
    }
  });

  test("CASE 2 (Biến thể JSON trong code fence Markdown)", () => {
    const input = `Dưới đây là công cụ tôi cần thực thi:
\`\`\`json
{
  "action": "tool_call",
  "tool": "read_file",
  "arguments": {
    "path": "src/index.ts"
  }
}
\`\`\``;

    const result = translator.translate(input);
    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.tool_calls[0].function.name).toBe("read_file");
      expect(JSON.parse(result.tool_calls[0].function.arguments)).toEqual({ path: "src/index.ts" });
    }
  });

  // ==========================================
  // CASE 3: Bash Command: cat pom.xml
  // ==========================================
  test("CASE 3: bash -lc cat pom.xml -> read_file('pom.xml')", () => {
    const input = "bash -lc cat pom.xml";

    const result = translator.translate(input);
    expect(result.type).toBe("tool_call");

    if (result.type === "tool_call") {
      expect(result.tool_calls.length).toBe(1);
      const call = result.tool_calls[0];
      expect(call.function.name).toBe("read_file");
      expect(JSON.parse(call.function.arguments)).toEqual({ path: "pom.xml" });
    }
  });

  test("CASE 3 (Biến thể lệnh đọc file): type pom.xml và cat trần", () => {
    // 1. cat pom.xml
    const res1 = translator.translate("cat pom.xml");
    expect(res1.type).toBe("tool_call");
    if (res1.type === "tool_call") {
      expect(res1.tool_calls[0].function.name).toBe("read_file");
      expect(JSON.parse(res1.tool_calls[0].function.arguments)).toEqual({ path: "pom.xml" });
    }

    // 2. type pom.xml (Windows shell)
    const res2 = translator.translate("type pom.xml");
    expect(res2.type).toBe("tool_call");
    if (res2.type === "tool_call") {
      expect(res2.tool_calls[0].function.name).toBe("read_file");
      expect(JSON.parse(res2.tool_calls[0].function.arguments)).toEqual({ path: "pom.xml" });
    }

    // 3. bash -lc "cat 'pom.xml'"
    const res3 = translator.translate("bash -lc \"cat 'pom.xml'\"");
    expect(res3.type).toBe("tool_call");
    if (res3.type === "tool_call") {
      expect(res3.tool_calls[0].function.name).toBe("read_file");
      expect(JSON.parse(res3.tool_calls[0].function.arguments)).toEqual({ path: "pom.xml" });
    }
  });

  // ==========================================
  // CASE 4: Bash Command: git status
  // ==========================================
  test("CASE 4: git status -> git_status()", () => {
    const input = "git status";

    const result = translator.translate(input);
    expect(result.type).toBe("tool_call");

    if (result.type === "tool_call") {
      expect(result.tool_calls.length).toBe(1);
      const call = result.tool_calls[0];
      expect(call.function.name).toBe("git_status");
      expect(JSON.parse(call.function.arguments)).toEqual({});
    }
  });

  test("CASE 4 (Biến thể git status có tiền tố bash -lc hoặc cờ ngắn)", () => {
    const res1 = translator.translate("bash -lc 'git status'");
    expect(res1.type).toBe("tool_call");
    if (res1.type === "tool_call") {
      expect(res1.tool_calls[0].function.name).toBe("git_status");
    }

    const res2 = translator.translate("git status --short");
    expect(res2.type).toBe("tool_call");
    if (res2.type === "tool_call") {
      expect(res2.tool_calls[0].function.name).toBe("git_status");
    }
  });

  // ==========================================
  // CASE 5: Final Answer
  // ==========================================
  test("CASE 5: 'Phân tích hoàn tất. Nguyên nhân là NullPointerException.' -> Final Answer", () => {
    const input = "Phân tích hoàn tất. Nguyên nhân là NullPointerException.";

    const result = translator.translate(input);
    expect(result.type).toBe("final_answer");

    if (result.type === "final_answer") {
      expect(result.content).toBe("Phân tích hoàn tất. Nguyên nhân là NullPointerException.");
    }
  });

  // ==========================================
  // Các lệnh Bash mở rộng theo yêu cầu
  // ==========================================
  test("Bash command mapping: ls, ls src, dir, grep, findstr, git diff", () => {
    // 1. ls -> list_dir(".")
    const resLs = translator.translate("ls");
    expect(resLs.type).toBe("tool_call");
    if (resLs.type === "tool_call") {
      expect(resLs.tool_calls[0].function.name).toBe("list_dir");
      expect(JSON.parse(resLs.tool_calls[0].function.arguments)).toEqual({ path: "." });
    }

    // 2. ls src -> list_dir("src")
    const resLsSrc = translator.translate("ls src");
    expect(resLsSrc.type).toBe("tool_call");
    if (resLsSrc.type === "tool_call") {
      expect(resLsSrc.tool_calls[0].function.name).toBe("list_dir");
      expect(JSON.parse(resLsSrc.tool_calls[0].function.arguments)).toEqual({ path: "src" });
    }

    // 3. dir -> list_dir(".")
    const resDir = translator.translate("dir");
    expect(resDir.type).toBe("tool_call");
    if (resDir.type === "tool_call") {
      expect(resDir.tool_calls[0].function.name).toBe("list_dir");
      expect(JSON.parse(resDir.tool_calls[0].function.arguments)).toEqual({ path: "." });
    }

    // 4. grep keyword -> grep_code(keyword)
    const resGrep = translator.translate("grep NullPointerException");
    expect(resGrep.type).toBe("tool_call");
    if (resGrep.type === "tool_call") {
      expect(resGrep.tool_calls[0].function.name).toBe("grep_code");
      expect(JSON.parse(resGrep.tool_calls[0].function.arguments)).toEqual({ query: "NullPointerException" });
    }

    // 5. findstr keyword -> grep_code(keyword)
    const resFindstr = translator.translate("findstr NullPointerException");
    expect(resFindstr.type).toBe("tool_call");
    if (resFindstr.type === "tool_call") {
      expect(resFindstr.tool_calls[0].function.name).toBe("grep_code");
      expect(JSON.parse(resFindstr.tool_calls[0].function.arguments)).toEqual({ query: "NullPointerException" });
    }

    // 6. git diff -> git_diff()
    const resGitDiff = translator.translate("git diff");
    expect(resGitDiff.type).toBe("tool_call");
    if (resGitDiff.type === "tool_call") {
      expect(resGitDiff.tool_calls[0].function.name).toBe("git_diff");
      expect(JSON.parse(resGitDiff.tool_calls[0].function.arguments)).toEqual({});
    }

    // 7. git diff pom.xml -> git_diff(path: "pom.xml")
    const resGitDiffFile = translator.translate("git diff pom.xml");
    expect(resGitDiffFile.type).toBe("tool_call");
    if (resGitDiffFile.type === "tool_call") {
      expect(resGitDiffFile.tool_calls[0].function.name).toBe("git_diff");
      expect(JSON.parse(resGitDiffFile.tool_calls[0].function.arguments)).toEqual({ path: "pom.xml" });
    }

    // 8. bash -lc find /mnt/data -> list_dir("/mnt/data")
    const resFind = translator.translate("bash -lc find /mnt/data");
    expect(resFind.type).toBe("tool_call");
    if (resFind.type === "tool_call") {
      expect(resFind.tool_calls[0].function.name).toBe("list_dir");
      expect(JSON.parse(resFind.tool_calls[0].function.arguments)).toEqual({ path: "/mnt/data" });
    }

    // 9. find src -name "*.ts" -> search_files(pattern: "*.ts", path: "src")
    const resFindPattern = translator.translate('find src -name "*.ts"');
    expect(resFindPattern.type).toBe("tool_call");
    if (resFindPattern.type === "tool_call") {
      expect(resFindPattern.tool_calls[0].function.name).toBe("search_files");
      expect(JSON.parse(resFindPattern.tool_calls[0].function.arguments)).toEqual({
        pattern: "*.ts",
        path: "src",
      });
    }

    // 10. bash -lc "npm test" -> run_command(cmd: "npm test")
    const resRunCmd = translator.translate('bash -lc "npm test"');
    expect(resRunCmd.type).toBe("tool_call");
    if (resRunCmd.type === "tool_call") {
      expect(resRunCmd.tool_calls[0].function.name).toBe("run_command");
      expect(JSON.parse(resRunCmd.tool_calls[0].function.arguments)).toEqual({ cmd: "npm test" });
    }
  });

  // ==========================================
  // Kiểm tra Thứ tự ưu tiên (Detection Priority)
  // A. JSON -> B. XML -> C. Bash -> D. Final Answer
  // ==========================================
  test("Priority check: JSON takes precedence when both JSON and text exist", () => {
    const inputWithJsonAndText = `Tôi sẽ kiểm tra file này:
{
  "action": "tool_call",
  "tool": "read_file",
  "arguments": { "path": "package.json" }
}`;
    const res = translator.translate(inputWithJsonAndText);
    expect(res.type).toBe("tool_call");
    if (res.type === "tool_call") {
      expect(res.tool_calls[0].function.name).toBe("read_file");
      expect(JSON.parse(res.tool_calls[0].function.arguments)).toEqual({ path: "package.json" });
    }
  });

  // ==========================================
  // Agent Loop Test: Multi-step Execution
  // ==========================================
  test("Agent Loop: executes multi-turn tool calling until final answer", async () => {
    // Giả lập M365 Model Client phản hồi qua 3 lượt:
    // Lượt 1: M365 trả về lệnh bash "git status"
    // Lượt 2: Sau khi có kết quả git status, M365 trả về XML tool_call read_file "pom.xml"
    // Lượt 3: Sau khi đọc pom.xml, M365 trả về Final Answer
    const mockResponses = [
      "bash -lc git status",
      `<tool_call>
{
  "name": "read_file",
  "arguments": { "path": "pom.xml" }
}
</tool_call>`,
      "Phân tích hoàn tất. Dự án sử dụng Java 17 và đã sửa lỗi phụ thuộc trong pom.xml."
    ];

    let turn = 0;
    const mockModelClient: IM365ModelClient = {
      async call(_prompt) {
        const response = mockResponses[turn] || "Xong";
        turn++;
        return response;
      },
    };

    const executedTools: Array<{ name: string; args: Record<string, any> }> = [];
    const mockToolExecutor: IToolExecutor = {
      async execute(name, args) {
        executedTools.push({ name, args });
        if (name === "git_status") {
          return "M pom.xml\n?? src/Test.java";
        }
        if (name === "read_file") {
          return "<project><modelVersion>4.0.0</modelVersion><artifactId>test</artifactId></project>";
        }
        return "OK";
      },
    };

    const agentLoop = new M365AgentLoop(mockModelClient, mockToolExecutor, translator);

    const result = await agentLoop.run("Kiểm tra thay đổi và phân tích pom.xml");

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(3);
    expect(result.finalAnswer).toBe("Phân tích hoàn tất. Dự án sử dụng Java 17 và đã sửa lỗi phụ thuộc trong pom.xml.");

    // Xác nhận cả 2 tool đã được thực thi theo thứ tự
    expect(executedTools.length).toBe(2);
    expect(executedTools[0].name).toBe("git_status");
    expect(executedTools[1].name).toBe("read_file");
    expect(executedTools[1].args).toEqual({ path: "pom.xml" });

    // Xác nhận lịch sử tin nhắn trong agent loop
    expect(result.messages.length).toBe(6); // user, assistant(tc1), tool_result1, assistant(tc2), tool_result2, assistant(final)
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].role).toBe("tool_result");
    expect(result.messages[3].role).toBe("assistant");
    expect(result.messages[4].role).toBe("tool_result");
    expect(result.messages[5].role).toBe("assistant");
  });

  // ==========================================
  // Multi-File / Parallel Tool Calling Tests
  // ==========================================
  test("Parallel Tool Calling: cat file1 file2 sinh 2 tool calls trong 1 lần gửi", () => {
    const input = "cat package.json src/version.ts";
    const res = translator.translate(input);
    expect(res.type).toBe("tool_call");
    if (res.type === "tool_call") {
      expect(res.tool_calls.length).toBe(2);
      expect(res.tool_calls[0].function.name).toBe("read_file");
      expect(JSON.parse(res.tool_calls[0].function.arguments)).toEqual({ path: "package.json" });
      expect(res.tool_calls[1].function.name).toBe("read_file");
      expect(JSON.parse(res.tool_calls[1].function.arguments)).toEqual({ path: "src/version.ts" });
    }
  });

  test("Parallel Tool Calling: nhiều dòng lệnh cat sinh các tool calls tương ứng trong 1 lần gửi", () => {
    const input = `cat package.json
cat src/version.ts
git status`;
    const res = translator.translate(input);
    expect(res.type).toBe("tool_call");
    if (res.type === "tool_call") {
      expect(res.tool_calls.length).toBe(3);
      expect(res.tool_calls[0].function.name).toBe("read_file");
      expect(JSON.parse(res.tool_calls[0].function.arguments)).toEqual({ path: "package.json" });
      expect(res.tool_calls[1].function.name).toBe("read_file");
      expect(JSON.parse(res.tool_calls[1].function.arguments)).toEqual({ path: "src/version.ts" });
      expect(res.tool_calls[2].function.name).toBe("git_status");
    }
  });

  test("Parallel Tool Calling: nhiều khối <tool_call> trong 1 phản hồi", () => {
    const input = `<tool_call>
{
  "name": "read_file",
  "arguments": { "path": "package.json" }
}
</tool_call>
<tool_call>
{
  "name": "read_file",
  "arguments": { "path": "src/version.ts" }
}
</tool_call>`;
    const res = translator.translate(input);
    expect(res.type).toBe("tool_call");
    if (res.type === "tool_call") {
      expect(res.tool_calls.length).toBe(2);
      expect(JSON.parse(res.tool_calls[0].function.arguments)).toEqual({ path: "package.json" });
      expect(JSON.parse(res.tool_calls[1].function.arguments)).toEqual({ path: "src/version.ts" });
    }
  });

  test("Parallel Tool Calling: mảng JSON các tool calls trong 1 phản hồi", () => {
    const input = `[
  { "name": "read_file", "arguments": { "path": "package.json" } },
  { "name": "read_file", "arguments": { "path": "src/version.ts" } }
]`;
    const res = translator.translate(input);
    expect(res.type).toBe("tool_call");
    if (res.type === "tool_call") {
      expect(res.tool_calls.length).toBe(2);
      expect(JSON.parse(res.tool_calls[0].function.arguments)).toEqual({ path: "package.json" });
      expect(JSON.parse(res.tool_calls[1].function.arguments)).toEqual({ path: "src/version.ts" });
    }
  });

  test("Tool Calling: tự động phục hồi và parse thành công khi LLM sinh unescaped double quotes trong code/script", () => {
    const rawWithUnescapedQuotes = `<tool_call>
{"name":"exec_command","arguments":{"cmd":"cat > .github/workflows/ci.yml <<'EOF'\\nif ($PSVersionTable.PSVersion.Major -ne 5) {\\n throw \\"Expected Windows PowerShell 5.1, got $($PSVersionTable.PSVersion)\\"\\n }\\nEOF\\ngit diff","workdir":"/app"}}
</tool_call>`;
    const res = translator.translate(rawWithUnescapedQuotes);
    expect(res.type).toBe("tool_call");
    if (res.type === "tool_call") {
      expect(res.tool_calls.length).toBe(1);
      expect(res.tool_calls[0].function.name).toBe("exec_command");
      const args = JSON.parse(res.tool_calls[0].function.arguments);
      expect(args.workdir).toBe("/app");
      expect(args.cmd).toContain("throw \"Expected Windows PowerShell 5.1");
    }
  });
});
