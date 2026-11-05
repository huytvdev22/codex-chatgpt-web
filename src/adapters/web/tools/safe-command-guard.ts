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
 * Lưu ý: Đã bỏ chặn quét đệ quy (recursive scan) và vòng lặp đọc file hàng loạt (batch read loop)
 * để trao quyền cho mô hình tự quyết định phương thức duyệt/khảo sát mã nguồn dựa trên năng lực tư duy.
 */
export class SafeCommandGuard {
  /**
   * Kiểm tra câu lệnh shell thô với các biểu thức hẹp nhằm ngăn:
   * - Đọc hàng loạt file bằng wildcard không chọn lọc (vd: *.sql, *.java).
   */
  static validateShellCommand(cmd: string): CommandValidationResult {
    const trimmed = String(cmd || "").trim();
    if (!trimmed) {
      return { allowed: true };
    }

    // Đã bỏ chặn rule BATCH_READ_DISALLOWED ($files = @(...) foreach ($f in $files) { Get-Content $f })
    // và RECURSIVE_SCAN_DISALLOWED (Get-ChildItem -Recurse) để trao quyền tự chủ khảo sát mã nguồn cho model.

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
