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
 *
 * Semantic tools như read_file, list_dir, search_files và grep_code được
 * forward trực tiếp tới Codex runtime, không còn được chuyển thành lệnh
 * PowerShell hoặc POSIX tại M365 adapter.
 *
 * Lưu ý: Đã bỏ chặn quét đệ quy (recursive scan) để trao quyền cho mô hình
 * tự quyết định phương thức duyệt file/thư mục dựa trên khả năng tư duy.
 */
export class SafeCommandGuard {
  /**
   * Kiểm tra câu lệnh shell thô với các biểu thức hẹp nhằm ngăn:
   * - Đọc hàng loạt file bằng vòng lặp shell.
   * - Đọc hàng loạt file bằng wildcard.
   */
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
          "Use native read_file or locate content with search_files or grep_code.",
      };
    }

    // Đã bỏ chặn rule RECURSIVE_SCAN_DISALLOWED (Get-ChildItem -Recurse, ls -R, tree /F)
    // để model tự do quyết định cách duyệt thư mục và tìm kiếm file.

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
          "Use native read_file with explicit paths or locate content with search_files or grep_code.",
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
