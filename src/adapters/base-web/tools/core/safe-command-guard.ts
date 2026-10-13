export interface StructuredRefusalPayload {
  status: "rejected";
  error: "GUARDRAIL_VIOLATION";
  rule:
    | "BATCH_READ_DISALLOWED"
    | "RECURSIVE_SCAN_DISALLOWED"
    | "WILDCARD_READ_DISALLOWED";
  message: string;
  guidance: string;
}

export interface CommandValidationResult {
  allowed: boolean;
  rule?:
    | "BATCH_READ_DISALLOWED"
    | "RECURSIVE_SCAN_DISALLOWED"
    | "WILDCARD_READ_DISALLOWED";
  message?: string;
  guidance?: string;
}

/**
 * Kiểm tra an toàn dành riêng cho native exec_command.
 * Ngăn chặn:
 * - Đọc hàng loạt file bằng vòng lặp.
 * - Quét đệ quy toàn bộ repository làm tràn ngữ cảnh.
 * - Đọc hàng loạt file bằng wildcard.
 */
export class SafeCommandGuard {
  static validateShellCommand(cmd: string): CommandValidationResult {
    const trimmed = String(cmd || "").trim();
    if (!trimmed) {
      return { allowed: true };
    }

    const isPowerShellBatchReadLoop =
      /(?:\$files\b|@\([^)]+?\)).*?foreach.*?Get-Content/is.test(trimmed) ||
      /(?:foreach\s*\(.*?\b(?:in|\$files)\b.*?\)|(?:ForEach-Object|%)\s*\{).*?Get-Content/is.test(trimmed) ||
      /\$files\s*=\s*@\(.*?Get-Content/is.test(trimmed);

    const isPosixBatchReadLoop =
      /(?:for\s+\w+\s+in\s+.*?;?\s*do|while\s+read).*?(?:cat|head|tail)\b/is.test(
        trimmed
      );

    if (isPowerShellBatchReadLoop || isPosixBatchReadLoop) {
      return {
        allowed: false,
        rule: "BATCH_READ_DISALLOWED",
        message:
          "Batch file reading loop in shell script is disallowed for safety and token conservation.",
        guidance:
          "Use native read_file for at most 3 files and no more than 150 total lines, or locate content with search_files or grep_code.",
      };
    }

    const isRecursiveTree =
      /^\s*tree\s+[\/\\][fF]/i.test(trimmed) ||
      /^\s*tree\s+-[a-zA-Z]*f/i.test(trimmed);

    const isPowerShellRecursiveScan =
      /\bGet-ChildItem\b/i.test(trimmed) &&
      /-(?:Recurse|r)\b/i.test(trimmed) &&
      !/-Depth\s+[12]\b/i.test(trimmed);

    const isPosixRecursiveScan = /^\s*ls\s+-[a-zA-Z]*R\b/i.test(trimmed);

    if (
      isRecursiveTree ||
      isPowerShellRecursiveScan ||
      isPosixRecursiveScan
    ) {
      return {
        allowed: false,
        rule: "RECURSIVE_SCAN_DISALLOWED",
        message:
          "Recursive directory scan across the repository is disallowed to prevent context overload.",
        guidance:
          "Use native list_dir for one directory level or use search_files and grep_code for targeted discovery.",
      };
    }

    const isPowerShellWildcardRead =
      /\bGet-Content\s+(?:-(?:LiteralPath|Path)\s+)?[\*]\.[a-zA-Z0-9]+/i.test(
        trimmed
      );

    const isPosixWildcardRead =
      /\bcat\s+[\*]\.[a-zA-Z0-9]+/i.test(trimmed);

    if (isPowerShellWildcardRead || isPosixWildcardRead) {
      return {
        allowed: false,
        rule: "WILDCARD_READ_DISALLOWED",
        message: "Wildcard bulk file reading is disallowed.",
        guidance:
          "Use native read_file with explicit paths and a total limit of 150 lines.",
      };
    }

    return { allowed: true };
  }

  static createStructuredRefusalPayload(
    validation: CommandValidationResult
  ): StructuredRefusalPayload {
    return {
      status: "rejected",
      error: "GUARDRAIL_VIOLATION",
      rule: validation.rule || "BATCH_READ_DISALLOWED",
      message:
        validation.message || "Command violated safe reading guardrails.",
      guidance:
        validation.guidance || "Use the native Codex tools for targeted reads.",
    };
  }
}
