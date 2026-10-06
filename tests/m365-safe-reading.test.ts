import { describe, expect, test } from "bun:test";
import {
  SafeCommandGuard,
  M365ToolBridge,
  PowerShellCommandStrategy,
  PosixCommandStrategy,
  type CommandValidationResult,
  type StructuredRefusalPayload,
} from "../src/adapters/m365-copilot/tools";

describe("M365 Safe File Reading & Command Guardrail Tests", () => {
  const psStrategy = new PowerShellCommandStrategy();
  const posixStrategy = new PosixCommandStrategy();

  describe("1. SafeCommandGuard.validateShellCommand - Target Violations", () => {
    test("Từ chối kịch bản PowerShell batch dump nhiều files bằng foreach và Get-Content", () => {
      const offendingCmd =
        "$ErrorActionPreference = 'Stop'; $files = @('README.md', 'index.html', 'css/style.css', 'js/app.js'); foreach ($file in $files) { Write-Output \"=== $file ===\"; $lineNumber = 0; Get-Content -LiteralPath $file -Encoding UTF8 | ForEach-Object { $lineNumber++; '{0,4}: {1}' -f $lineNumber, $_ } }";
      const result = SafeCommandGuard.validateShellCommand(offendingCmd);
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe("BATCH_READ_DISALLOWED");
      expect(result.message).toContain("Batch file reading loop");
    });

    test("Từ chối kịch bản PowerShell pipeline @(...); ... Get-Content", () => {
      const cmd = "$files = @('a.js', 'b.js'); $files | ForEach-Object { Get-Content $_ }";
      const result = SafeCommandGuard.validateShellCommand(cmd);
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe("BATCH_READ_DISALLOWED");
    });

    test("Từ chối kịch bản POSIX batch read loop (for f in ... do cat)", () => {
      const cmd = "for f in a.js b.js c.js; do cat $f; done";
      const result = SafeCommandGuard.validateShellCommand(cmd);
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe("BATCH_READ_DISALLOWED");
    });

    test("Từ chối lệnh tree /F và tree /f quét cây thư mục toàn diện", () => {
      expect(SafeCommandGuard.validateShellCommand("tree /F").allowed).toBe(false);
      expect(SafeCommandGuard.validateShellCommand("tree \\f").allowed).toBe(false);
      expect(SafeCommandGuard.validateShellCommand("tree -f").allowed).toBe(false);
      expect(SafeCommandGuard.validateShellCommand("tree /F | Out-File tree.txt").allowed).toBe(false);
    });

    test("Từ chối lệnh Get-ChildItem -Recurse khi không có giới hạn Depth nhỏ", () => {
      expect(SafeCommandGuard.validateShellCommand("Get-ChildItem -Recurse").allowed).toBe(false);
      expect(SafeCommandGuard.validateShellCommand("Get-ChildItem -Path . -r").allowed).toBe(false);
    });

    test("Từ chối lệnh ls -R đệ quy POSIX", () => {
      expect(SafeCommandGuard.validateShellCommand("ls -R").allowed).toBe(false);
      expect(SafeCommandGuard.validateShellCommand("ls -laR").allowed).toBe(false);
    });

    test("Từ chối lệnh Wildcard dump toàn bộ file (*.ext)", () => {
      expect(SafeCommandGuard.validateShellCommand("Get-Content *.js").allowed).toBe(false);
      expect(SafeCommandGuard.validateShellCommand("cat *.ts").allowed).toBe(false);
    });
  });

  describe("2. Chống False Positive - Whitelist các câu lệnh CLI phát triển phổ biến", () => {
    test("Cho phép hoàn toàn các lệnh Git chuẩn", () => {
      expect(SafeCommandGuard.validateShellCommand("git status").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("git status --short").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("git diff").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("git diff HEAD~1").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("git log -n 5 --oneline").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("git branch -a").allowed).toBe(true);
    });

    test("Cho phép các lệnh Build / Test / Package Manager", () => {
      expect(SafeCommandGuard.validateShellCommand("npm test").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("npm run build").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("bun test tests/m365").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("cargo test --workspace").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("npx vitest run").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("node scripts/check-circular-deps.js").allowed).toBe(true);
    });

    test("Cho phép lệnh liệt kê thư mục cấp 1", () => {
      expect(SafeCommandGuard.validateShellCommand("ls").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("ls -la").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("dir").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("Get-ChildItem").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("Get-ChildItem -Path src").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("Get-ChildItem -Recurse -Depth 1").allowed).toBe(true);
    });

    test("Cho phép đọc 1 file đơn lẻ thông thường", () => {
      expect(SafeCommandGuard.validateShellCommand("cat package.json").allowed).toBe(true);
      expect(SafeCommandGuard.validateShellCommand("Get-Content -LiteralPath README.md").allowed).toBe(true);
    });
  });

  describe("3. Structured Refusal Payload", () => {
    test("Sinh structured payload JSON chuẩn khi vi phạm", () => {
      const validation: CommandValidationResult = {
        allowed: false,
        rule: "BATCH_READ_DISALLOWED",
        message: "Batch read disallowed",
        guidance: "Use read_file",
      };
      const payload: StructuredRefusalPayload = SafeCommandGuard.createStructuredRefusalPayload(validation);
      expect(payload.status).toBe("rejected");
      expect(payload.error).toBe("GUARDRAIL_VIOLATION");
      expect(payload.rule).toBe("BATCH_READ_DISALLOWED");
      expect(payload.message).toBe("Batch read disallowed");
      expect(payload.guidance).toBe("Use read_file");
    });

    test("Sinh câu lệnh shell an toàn cho PowerShell và POSIX", () => {
      const validation: CommandValidationResult = {
        allowed: false,
        rule: "RECURSIVE_SCAN_DISALLOWED",
        message: "Recursive scan blocked",
      };
      const psCmd = SafeCommandGuard.createStructuredRefusalCommand(validation, "powershell");
      expect(psCmd).toContain("powershell -NoProfile -EncodedCommand");

      const posixCmd = SafeCommandGuard.createStructuredRefusalCommand(validation, "posix");
      expect(posixCmd).toContain("printf '%s\\n'");
      expect(posixCmd).toContain("GUARDRAIL_VIOLATION");
    });
  });

  describe("4. SafeCommandGuard.clampReadFileRange & Multi-file Quota", () => {
    test("Mặc định đọc tối đa 150 dòng khi không truyền end_line", () => {
      const range = SafeCommandGuard.clampReadFileRange({});
      expect(range.startLine).toBe(1);
      expect(range.endLine).toBe(150);
    });

    test("Bảo toàn range hợp lệ nếu khoảng cách <= 150 dòng", () => {
      const range = SafeCommandGuard.clampReadFileRange({ start_line: 10, end_line: 60 });
      expect(range.startLine).toBe(10);
      expect(range.endLine).toBe(60);
    });

    test("Tự động kẹp về tối đa 150 dòng nếu yêu cầu range quá lớn (ví dụ 1000 dòng)", () => {
      const range = SafeCommandGuard.clampReadFileRange({ start_line: 1, end_line: 1000 });
      expect(range.startLine).toBe(1);
      expect(range.endLine).toBe(150);
    });

    test("Cho phép đọc 2 files với hạn ngạch chia đều (75 dòng/file)", () => {
      const result = SafeCommandGuard.handleReadFile({ files: ["a.ts", "b.ts"] }, psStrategy);
      expect(result.name).toBe("exec_command");
      expect(result.args.cmd).toContain(";");
    });

    test("Cho phép đọc 3 files với hạn ngạch chia đều (50 dòng/file)", () => {
      const result = SafeCommandGuard.handleReadFile({ files: ["a.ts", "b.ts", "c.ts"] }, psStrategy);
      expect(result.name).toBe("exec_command");
      expect(result.args.cmd).toContain(";");
    });

    test("Từ chối khi yêu cầu đọc trên 3 files (ví dụ 4 files)", () => {
      const result = SafeCommandGuard.handleReadFile(
        { files: ["a.ts", "b.ts", "c.ts", "d.ts"] },
        psStrategy
      );
      expect(result.name).toBe("exec_command");
      expect(result.args.cmd).toContain("powershell -NoProfile -EncodedCommand");
    });
  });

  describe("5. Tích hợp M365ToolBridge.mapToolCall", () => {
    test("M365ToolBridge tự động đánh chặn exec_command độc hại kể cả khi clientTools có exec_command", () => {
      const clientTools = [{ name: "exec_command", description: "Run command", parameters: {} }];
      const dangerousCmd =
        "$files = @('1.txt','2.txt','3.txt','4.txt'); foreach ($f in $files) { Get-Content $f }";

      const mapped = M365ToolBridge.mapToolCall(
        {
          name: "exec_command",
          arguments: { cmd: dangerousCmd },
        },
        clientTools as any,
        psStrategy
      );

      expect(mapped.name).toBe("exec_command");
      const args = JSON.parse(mapped.arguments);
      expect(args.cmd).not.toContain("foreach");
      expect(args.cmd).toContain("powershell -NoProfile -EncodedCommand");
    });

    test("M365ToolBridge giữ nguyên các câu lệnh an toàn (như git status)", () => {
      const clientTools = [{ name: "exec_command", description: "Run command", parameters: {} }];
      const safeCmd = "git status --short";

      const mapped = M365ToolBridge.mapToolCall(
        {
          name: "exec_command",
          arguments: { cmd: safeCmd },
        },
        clientTools as any,
        psStrategy
      );

      expect(mapped.name).toBe("exec_command");
      const args = JSON.parse(mapped.arguments);
      expect(args.cmd).toBe(safeCmd);
    });

    test("M365ToolBridge map tool read_file áp dụng hạn ngạch 150 dòng", () => {
      const mapped = M365ToolBridge.mapToolCall(
        {
          name: "read_file",
          arguments: { path: "src/index.ts" },
        },
        [],
        psStrategy
      );

      expect(mapped.name).toBe("exec_command");
      const args = JSON.parse(mapped.arguments);
      expect(args.cmd).toContain("powershell -NoProfile -EncodedCommand");
    });
  });
});
