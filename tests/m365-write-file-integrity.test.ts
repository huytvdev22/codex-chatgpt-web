import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  AtomicFileWriter,
} from "../src/adapters/m365-copilot/atomic-file-writer";
import {
  M365ToolBridge,
  normalizeFileContent,
} from "../src/adapters/m365-copilot/tool-bridge";
import {
  M365ToolCallDetector,
} from "../src/adapters/m365-copilot/markdown";
import {
  M365OutputTranslator,
  XmlToolCallDetector,
} from "../src/adapters/m365-copilot/output-translator";
import {
  PosixCommandStrategy,
} from "../src/adapters/m365-copilot/strategies/posix";
import {
  PowerShellCommandStrategy,
} from "../src/adapters/m365-copilot/strategies/powershell";
import {
  LocalToolExecutor,
} from "../src/adapters/m365-copilot/agent-loop";

describe("M365 Write File Integrity & Atomic Pipeline Tests", () => {
  const testDir = path.join(os.tmpdir(), `m365-integrity-test-${Date.now()}`);

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Test 1: Tạo nội dung tài liệu phức tạp > 100.000 ký tự với BEGIN_FILE và END_FILE
  // =========================================================================
  function generateComplexDocument(minChars = 105000): string {
    const header = `# BEGIN_FILE
# Tài Liệu Đặc Tả Kiến Trúc Hệ Thống Codex M365 (23 Mục & Phụ Lục)

> **Cảnh báo**: Tài liệu chứa ký tự đặc biệt tiếng Việt có dấu, code fence Mermaid, Bảng Markdown, escape backslash và quote.

| STT | Module | Mô Tả | Trạng Thái | Checksum |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Core Adapter | Bộ chuyển đổi đa nền tảng | Hoàn thành | OK |
| 2 | Tool Bridge | Cầu nối ánh xạ công cụ | Hoàn thành | OK |
| 3 | Atomic Writer | Cơ chế ghi file nguyên tử | Hoàn thành | OK |

\`\`\`mermaid
graph TD
    A[M365 Copilot DOM] -->|SSE Stream| B(M365ToolCallDetector)
    B -->|Accumulate Chunks| C{Hoàn Chỉnh?}
    C -->|Chưa đóng| D[Chờ Thêm Chunk]
    C -->|Đã đóng| E[AtomicFileWriter]
    E -->|Staging File| F[Verify Byte & SHA256]
    F -->|Match| G[Atomic Rename File Đích]
\`\`\`

\`\`\`json
{
  "project": "codex-chatgpt-web",
  "version": "1.0.0",
  "features": ["atomic_write", "sha256_verify", "posix_powershell"]
}
\`\`\`

`;

    let body = "";
    let sectionIdx = 1;
    while (header.length + body.length < minChars) {
      body += `
## Mục ${sectionIdx}. Đặc tả kỹ thuật chi tiết phân hệ ${sectionIdx}

Nội dung phần này mô tả các ràng buộc về streaming, chunk processing, và serialization.
Đoạn trích dẫn: "RestClient" được cấu hình với timeout là 60000ms.
Hàm \`executeCommand()\` hỗ trợ tham số \`{ shell: "/bin/bash", env: { LANG: "en_US.UTF-8" } }\`.
Đường dẫn file mẫu: \`C:\\Users\\admin\\AppData\\Local\\Temp\\sample.txt\` hoặc \`/tmp/m365/test.md\`.
Biểu thức toán học / regex: '[a-zA-Z0-9_\\-\\.]+' và dấu gạch chéo ngược: \\ \\\\ \\\\n.
Tiếng Việt: "Thử nghiệm độ nguyên vẹn dữ liệu, không được phép mất mát bất kỳ byte nào từ đầu đến cuối."

| Chỉ số | Tham số | Giá trị |
| --- | --- | --- |
| S${sectionIdx}-1 | Max Buffer | 50MB |
| S${sectionIdx}-2 | Checksum Algorithm | SHA-256 |
| S${sectionIdx}-3 | Atomic Rename | Posix rename / Win MoveFileEx |

`;
      sectionIdx++;
    }

    const footer = `
# Phụ Lục A: Bảng Tra Cứu Mã Lỗi
Tất cả các mã lỗi từ E001 đến E999.

# Phụ Lục B: Danh Sách Kiểm Tra Bảo Mật
Không ghi log chứa thông tin nhạy cảm.

# END_FILE
`;
    return header + body + footer;
  }

  test("TEST 1: AtomicFileWriter ghi tài liệu > 100.000 ký tự chính xác 100% byte-for-byte", () => {
    const content = generateComplexDocument(105000);
    const targetFile = path.join(testDir, "docs", "spec-23-sections.md");

    expect(content.length).toBeGreaterThan(100000);
    expect(content.includes("# BEGIN_FILE")).toBe(true);
    expect(content.includes("# END_FILE")).toBe(true);
    expect(content.includes("```mermaid")).toBe(true);
    expect(content.includes("| STT | Module |")).toBe(true);

    const result = AtomicFileWriter.writeFile(targetFile, content);

    expect(result.success).toBe(true);
    expect(result.bytesWritten).toBe(Buffer.byteLength(content, "utf8"));
    expect(result.sha256).toBe(AtomicFileWriter.computeSha256(content));

    // Đọc lại từ đĩa và kiểm tra
    const readBack = fs.readFileSync(targetFile, "utf8");
    expect(readBack).toBe(content);
    expect(AtomicFileWriter.computeSha256(readBack)).toBe(result.sha256);
    expect(Buffer.byteLength(readBack, "utf8")).toBe(result.bytesWritten);

    // Xác minh không còn file rác .tmp trong thư mục
    const dirFiles = fs.readdirSync(path.dirname(targetFile));
    expect(dirFiles.filter(f => f.includes(".tmp.")).length).toBe(0);
  });

  // =========================================================================
  // Test 2: Tool call bị chia thành nhiều streaming chunks ghép lại hoàn chỉnh
  // =========================================================================
  test("TEST 2: Tool call bị chia thành 50+ streaming chunks ghép lại thành công và parse hoàn chỉnh", () => {
    const fullContent = generateComplexDocument(102000);
    const jsonArgs = JSON.stringify({
      path: "architecture/ARCHITECTURE_SPEC.md",
      content: fullContent,
    });
    const fullToolCallXml = `<tool_call>\n{"name": "write_file", "arguments": ${jsonArgs}}\n</tool_call>`;

    const detector = new M365ToolCallDetector();

    // Chia chuỗi XML lớn thành nhiều chunk nhỏ (mỗi chunk ~2000 ký tự)
    const chunkSize = 2048;
    let detectedCallsCount = 0;

    for (let i = 0; i < fullToolCallXml.length; i += chunkSize) {
      const chunk = fullToolCallXml.slice(i, i + chunkSize);
      const isLastChunk = i + chunkSize >= fullToolCallXml.length;

      const result = detector.processChunk(chunk);

      if (isLastChunk) {
        expect(result.toolCalls.length).toBe(1);
        detectedCallsCount += result.toolCalls.length;
        const call = result.toolCalls[0];
        const callArgs = call.arguments as Record<string, any>;
        expect(call.name).toBe("write_file");
        expect(callArgs.path).toBe("architecture/ARCHITECTURE_SPEC.md");
        expect(callArgs.content).toBe(fullContent);
        expect(callArgs.content.startsWith("# BEGIN_FILE")).toBe(true);
        expect(callArgs.content.endsWith("# END_FILE\n")).toBe(true);
        expect(AtomicFileWriter.computeSha256(callArgs.content)).toBe(
          AtomicFileWriter.computeSha256(fullContent)
        );
      } else {
        // Trong khi chưa gặp </tool_call>, không được emit tool call dở dang
        expect(result.toolCalls.length).toBe(0);
      }
    }

    expect(detectedCallsCount).toBe(1);
    const finishRes = detector.finish();
    expect(finishRes.remainingText).toBe("");
  });

  // =========================================================================
  // Test 3: Stream bị ngắt giữa JSON arguments -> KHÔNG thực thi tool call dở dang
  // =========================================================================
  test("TEST 3: Stream bị ngắt giữa chừng -> fail closed và không leak control frame", () => {
    const detector = new M365ToolCallDetector();

    // Bắt đầu tool call nhưng bị đứt đoạn ở mục 5.7 (không có dấu đóng JSON và không có </tool_call>)
    const cutChunk1 = `<tool_call>\n{\n  "name": "write_file",\n  "arguments": {\n    "path": "test.md",\n    "content": "# Mục 1\\nNội dung\\n# Mục 5.7\\nĐang ghi dở ở đây`;
    
    const r1 = detector.processChunk(cutChunk1);
    expect(r1.toolCalls.length).toBe(0);

    // Giả lập stream kết thúc đột ngột (finish() được gọi khi inToolCall = true)
    const finishRes = detector.finish();
    expect(finishRes.detectedToolCall).toBeUndefined();
    expect(finishRes.remainingText).toBe("");
    expect(finishRes.protocolError).toBe("INCOMPLETE_TOOL_CALL");
  });

  test("TEST 3b: XmlToolCallDetector không bao giờ nhận diện thẻ <tool_call> mở mà chưa có thẻ đóng </tool_call>", () => {
    const xmlDetector = new XmlToolCallDetector();

    const truncatedXml = `<tool_call>
{
  "name": "write_file",
  "arguments": {
    "path": "test.md",
    "content": "bị cắt giữa chừng
`;

    const result = xmlDetector.detect(truncatedXml);
    // Tuyệt đối không được trả về kết quả cắt xén
    expect(result).toBeNull();
  });

  // =========================================================================
  // Test 4 & 5: File output bị thiếu hoặc checksum không khớp -> rollback & bảo vệ file đích
  // =========================================================================
  test("TEST 4 & 5: AtomicFileWriter: nếu checksum hoặc kích thước không khớp, giữ nguyên 100% file đích cũ và xóa file tạm", () => {
    const targetFile = path.join(testDir, "important_file.md");
    const originalContent = "# DỮ LIỆU GỐC CẦN BẢO VỆ\nPhiên bản 1.0 không được phép hỏng!";
    fs.writeFileSync(targetFile, originalContent, "utf8");

    const corruptedContent = "# DỮ LIỆU MỚI BỊ THIẾU NỘI DUNG...";
    const wrongSha256 = "0000000000000000000000000000000000000000000000000000000000000000";

    // Cố gắng ghi với checksum sai
    expect(() => {
      AtomicFileWriter.writeFile(targetFile, corruptedContent, {
        expectedSha256: wrongSha256,
      });
    }).toThrow(/Checksum mismatch/);

    // Xác minh file đích cũ còn nguyên vẹn 100%
    const currentTargetContent = fs.readFileSync(targetFile, "utf8");
    expect(currentTargetContent).toBe(originalContent);

    // Xác minh không còn file .tmp còn sót lại
    const dirFiles = fs.readdirSync(testDir);
    expect(dirFiles.filter(f => f.includes(".tmp.")).length).toBe(0);
  });

  test("TEST 4b: AtomicFileWriter: nếu kích thước byte mong đợi không khớp, ném lỗi và không đổi file đích", () => {
    const targetFile = path.join(testDir, "size_check_file.md");
    const originalContent = "Original Size File Content";
    fs.writeFileSync(targetFile, originalContent, "utf8");

    const newContent = "New Partial Content";
    const wrongByteLength = 999999; // Mong đợi gần 1MB nhưng thực tế chỉ có 19 bytes

    expect(() => {
      AtomicFileWriter.writeFile(targetFile, newContent, {
        expectedByteLength: wrongByteLength,
      });
    }).toThrow(/Byte length mismatch/);

    expect(fs.readFileSync(targetFile, "utf8")).toBe(originalContent);
  });

  // =========================================================================
  // Test 6: Checksum đầu vào và đầu ra giống nhau 100% (bảo toàn Markdown, code fence, table)
  // =========================================================================
  test("TEST 6: normalizeFileContent bảo toàn byte-for-byte Markdown, Code Fence Mermaid và Bảng", () => {
    const markdownSample = `# Tiêu đề
\`\`\`mermaid
graph TD
    A --> B
\`\`\`
| Cột 1 | Cột 2 |
| --- | --- |
| Dữ liệu với dấu \\ | Dữ liệu dấu * và _ |
Đường dẫn: \`C:\\path\\to\\file\`
Dòng kết thúc bằng backslash \\
`;
    // Với file markdown, normalizeFileContent phải giữ nguyên 100%
    const normalized = normalizeFileContent(markdownSample, "spec.md");
    expect(normalized).toBe(markdownSample);
    expect(AtomicFileWriter.computeSha256(normalized)).toBe(
      AtomicFileWriter.computeSha256(markdownSample)
    );
  });

  // =========================================================================
  // Test 7: M365ToolBridge tự động chuyển nội dung lớn thành Staging File
  // =========================================================================
  test("TEST 7: M365ToolBridge.mapToolCall tự động dùng Staging File cho write_file > 1024 bytes", () => {
    const largeDoc = generateComplexDocument(5000);
    const rawToolCall = {
      name: "write_file",
      arguments: {
        path: "src/docs/spec.md",
        content: largeDoc,
      },
    };

    // Client chỉ hỗ trợ execute_command
    const clientTools = [
      {
        type: "function",
        function: {
          name: "execute_command",
          description: "Execute bash or powershell command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
    ];

    const mapped = M365ToolBridge.mapToolCall(rawToolCall, clientTools as any, { shell: "bash" });

    expect(mapped.name).toBe("exec_command");
    const args = JSON.parse(mapped.arguments);
    expect(args.cmd).toBeDefined();

    // Command line phải ngắn gọn (< 2000 ký tự), KHÔNG chứa toàn bộ nội dung lớn qua tham số dòng lệnh
    // Command sử dụng staging file path và câu lệnh Node.js atomic verify & rename
    expect(args.cmd.length).toBeLessThan(2000);
    expect(args.cmd).toContain("codex_wf_");
    expect(args.cmd).toContain("src/docs/spec.md");
    expect(args.cmd).toContain("sha256");
  });

  test("TEST 7b: PowerShellCommandStrategy tạo lệnh Staging File an toàn cho Windows CLI (< 8191 chars)", () => {
    const strategy = new PowerShellCommandStrategy();
    const stagingPath = "C:\\Temp\\m365_staging_123.tmp";
    const targetPath = "C:\\Project\\output.md";
    const expectedSha = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const expectedLen = 150000;

    const cmd = strategy.writeFile(targetPath, "", {
      stagingPath,
      expectedSha256: expectedSha,
      expectedLength: expectedLen,
    });

    // Lệnh PowerShell EncodedCommand an toàn nằm dưới giới hạn 8191 của Windows CLI
    expect(cmd.length).toBeLessThan(8191);
    expect(cmd).toContain("powershell -NoProfile -EncodedCommand");
  });

  // =========================================================================
  // Test 8: LocalToolExecutor với AtomicFileWriter và Checksum Verification
  // =========================================================================
  test("TEST 8: LocalToolExecutor write_file trả về kết quả chứa byte count và sha256 checksum", async () => {
    const executor = new LocalToolExecutor();
    const filePath = path.join(testDir, "executor_output.md");
    const docContent = generateComplexDocument(2000);

    const output = await executor.execute("write_file", {
      path: filePath,
      content: docContent,
    });

    expect(output).toContain("Ghi file thành công");
    expect(output).toContain("bytes");
    expect(output).toContain("sha256:");
    expect(output).toContain(AtomicFileWriter.computeSha256(docContent));

    const written = fs.readFileSync(filePath, "utf8");
    expect(written).toBe(docContent);
  });
});
