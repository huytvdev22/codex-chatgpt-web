
import type { PlatformCommandStrategy } from "./command-strategies/types";

export interface StructuredRefusalPayload {
  status: "rejected";
  error: "GUARDRAIL_VIOLATION";
  rule: "BATCH_READ_DISALLOWED" | "RECURSIVE_SCAN_DISALLOWED" | "WILDCARD_READ_DISALLOWED";
  message: string;
  guidance: string;
}

export interface CommandValidationResult {
  allowed: boolean;
  rule?: "BATCH_READ_DISALLOWED" | "RECURSIVE_SCAN_DISALLOWED" | "WILDCARD_READ_DISALLOWED";
  message?: string;
  guidance?: string;
}

export class SafeCommandGuard {
  static readonly MAX_FILES_PER_READ = 3;
  static readonly MAX_TOTAL_LINES = 150;

  /**
   * Kiểm tra câu lệnh shell thô (từ exec_command) với Regex rất hẹp để loại trừ False Positive.
   * Tuyệt đối không chặn các câu lệnh phổ biến (git, npm, npx, bun, cargo, node, python, ls, dir).
   */
  static validateShellCommand(cmd: string): CommandValidationResult {

    const trimmed = (cmd || "").trim();
    if (!trimmed) {
      return { allowed: true };
    }

    // 1. Regex kiểm tra Batch Reading loop trong shell script
    // Nhận diện script lặp qua mảng file để đọc hàng loạt với Get-Content / cat
    const isPsBatchReadLoop =
      /(?:\$files\b|@\([^)]+?\)).*?foreach.*?Get-Content/is.test(trimmed) ||
      /(?:foreach\s*\(.*?\b(?:in|\$files)\b.*?\)|(?:ForEach-Object|%)\s*\{).*?Get-Content/is.test(trimmed) ||
      /\$files\s*=\s*@\(.*?Get-Content/is.test(trimmed);

    const isPosixBatchReadLoop =
      /(?:for\s+\w+\s+in\s+.*?;?\s*do|while\s+read).*?(?:cat|head|tail)\b/is.test(trimmed);

    if (isPsBatchReadLoop || isPosixBatchReadLoop) {
      return {
        allowed: false,
        rule: "BATCH_READ_DISALLOWED",
        message: "Batch file reading loop in shell script is disallowed for safety and token conservation.",
        guidance: "Please inspect at most 3 files with total <= 150 lines using read_file or Get-Content with line paging, or locate files using search_files / grep_code.",
      };
    }

    // 2. Regex kiểm tra Recursive Scan toàn bộ dự án
    // Cho phép Get-ChildItem thông thường, chỉ chặn khi có cờ -Recurse mà không giới hạn -Depth nhỏ
    const isRecursiveTree =
      /^\s*tree\s+[\/\\][fF]/i.test(trimmed) ||
      /^\s*tree\s+-[a-zA-Z]*f/i.test(trimmed);

    const isPsRecurse =
      /\bGet-ChildItem\b/i.test(trimmed) &&
      /-(?:Recurse|r)\b/i.test(trimmed) &&
      !/-Depth\s+[12]\b/i.test(trimmed);

    const isPosixRecurse =
      /^\s*ls\s+-[a-zA-Z]*R\b/i.test(trimmed);

    if (isRecursiveTree || isPsRecurse || isPosixRecurse) {
      return {
        allowed: false,
        rule: "RECURSIVE_SCAN_DISALLOWED",
        message: "Recursive directory scan across the repository is disallowed to prevent context overload.",
        guidance: "Please use list_dir (depth=1) or search_files / grep_code to inspect specific target folders or search by keyword.",
      };
    }

    // 3. Regex kiểm tra Wildcard Dump (Get-Content *.js, cat *.ts)
    const isPsWildcardRead = /\bGet-Content\s+(?:-(?:LiteralPath|Path)\s+)?[\*]\.[a-zA-Z0-9]+/i.test(trimmed);
    const isPosixWildcardRead = /\bcat\s+[\*]\.[a-zA-Z0-9]+/i.test(trimmed);

    if (isPsWildcardRead || isPosixWildcardRead) {
      return {
        allowed: false,
        rule: "WILDCARD_READ_DISALLOWED",
        message: "Wildcard bulk file reading (*.ext) is disallowed.",
        guidance: "Please specify concrete target file paths using read_file (max 150 lines total).",
      };
    }

    return { allowed: true };
  }

  /**
   * Tạo Structured Refusal Payload chuẩn JSON
   */
  static createStructuredRefusalPayload(validation: CommandValidationResult): StructuredRefusalPayload {

    return {
      status: "rejected",
      error: "GUARDRAIL_VIOLATION",
      rule: validation.rule || "BATCH_READ_DISALLOWED",
      message: validation.message || "Command violated safe reading guardrails.",
      guidance: validation.guidance || "Please limit reads to at most 150 lines.",
    };
  }

  /**
   * Tạo câu lệnh shell an toàn để in ra Structured JSON Payload cho IDE/Agent tiếp nhận
   */
  static createStructuredRefusalCommand(
    validation: CommandValidationResult,
    platform: "powershell" | "posix" = "powershell"
  ): string {

    const payload = this.createStructuredRefusalPayload(validation);
    const jsonStr = JSON.stringify(payload, null, 2);

    if (platform === "powershell") {
      const b64 = Buffer.from(jsonStr, "utf8").toString("base64");
      const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\nWrite-Output ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')));`;
      return `powershell -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
    }

    const escaped = jsonStr.replace(/'/g, `'\\''`);
    return `printf '%s\\n' '${escaped}'`;
  }

  /**
   * Trích xuất danh sách file từ đối số của read_file
   */
  static parseTargetFiles(args: Record<string, any>): string[] {

    if (Array.isArray(args.files)) {
      return args.files.map(String).map(s => s.trim()).filter(Boolean);
    }
    if (Array.isArray(args.paths)) {
      return args.paths.map(String).map(s => s.trim()).filter(Boolean);
    }
    const single = args.path || args.file || args.filename;
    if (typeof single === "string" && single.includes(",") && !single.includes(" ")) {
      const parts = single.split(",").map(s => s.trim()).filter(Boolean);
      if (parts.length > 1) return parts;
    }
    return [String(single || "package.json")];
  }

  /**
   * Kẹp khoảng dòng đọc file an toàn (mặc định tối đa 150 dòng)
   */
  static clampReadFileRange(
    args: { start_line?: any; end_line?: any; startline?: any; endline?: any; start?: any; end?: any },
    maxLines = SafeCommandGuard.MAX_TOTAL_LINES
  ): { startLine: number; endLine: number } {

    const rawStart = parseInt(String(args.start_line || args.startline || args.start || 1), 10) || 1;
    const startLine = Math.max(1, rawStart);
    let rawEnd = parseInt(String(args.end_line || args.endline || args.end || 0), 10) || 0;

    if (rawEnd <= 0) {
      return {
        startLine,
        endLine: startLine + maxLines - 1,
      };
    }

    if (rawEnd < startLine) {
      rawEnd = startLine;
    }

    if (rawEnd - startLine + 1 > maxLines) {
      return {
        startLine,
        endLine: startLine + maxLines - 1,
      };
    }

    return {
      startLine,
      endLine: rawEnd,
    };
  }

  /**
   * Điều phối xử lý tool read_file với hạn ngạch tối đa 3 files và tổng số dòng <= 150
   */
  static handleReadFile(
    args: Record<string, any>,
    strategy: PlatformCommandStrategy
  ): { name: string; args: { cmd: string } } {

    const files = this.parseTargetFiles(args);
    const platform = strategy.platformName === "posix" ? "posix" : "powershell";

    // Nếu vượt quá 3 files: từ chối bằng Structured Refusal
    if (files.length > this.MAX_FILES_PER_READ) {
      const refusal: CommandValidationResult = {
        allowed: false,
        rule: "BATCH_READ_DISALLOWED",
        message: `Requested reading ${files.length} files at once, exceeding the limit of ${this.MAX_FILES_PER_READ} files.`,
        guidance: `Please read at most 3 files per request with total <= 150 lines, or use search_files / grep_code to locate specific information.`,
      };
      return {
        name: "exec_command",
        args: { cmd: this.createStructuredRefusalCommand(refusal, platform) },
      };
    }

    // Nếu chỉ có 1 file (trường hợp phổ biến nhất)
    if (files.length === 1) {
      const range = this.clampReadFileRange(args, this.MAX_TOTAL_LINES);
      const cmd = strategy.readFile(files[0], range);
      return {
        name: "exec_command",
        args: { cmd },
      };
    }

    // Nếu từ 2 đến 3 files: phân bổ hạn ngạch dòng (75 dòng/file cho 2 files, 50 dòng/file cho 3 files)
    const quotaPerFile = Math.floor(this.MAX_TOTAL_LINES / files.length);
    const cmds = files.map((f) => {
      const range = this.clampReadFileRange(args, quotaPerFile);
      return strategy.readFile(f, range);
    });

    return {
      name: "exec_command",
      args: { cmd: cmds.join("; ") },
    };
  }
}
