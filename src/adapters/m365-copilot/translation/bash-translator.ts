import { logFunctionInput } from "../debug-logger";
/**
 * Giao diện đại diện cho một quy tắc phân tích lệnh Bash/Shell sang Tool Call
 * Tuân thủ Open/Closed Principle (OCP) & Single Responsibility Principle (SRP)
 */
export interface IBashCommandRule {
  readonly name: string;
  match(normalizedCommand: string): boolean;
  translate(normalizedCommand: string): Array<{ name: string; arguments: Record<string, any> }> | { name: string; arguments: Record<string, any> } | null;
}

/**
 * Loại bỏ tiền tố vỏ bọc lệnh shell như bash -lc, bash -c, sh -c và dấu nháy bao ngoài
 */
export function stripShellPrefix(cmd: string): string {

  let cleaned = cmd.trim();

  // Khử code fences nếu có ```bash hoặc ```sh
  cleaned = cleaned.replace(/^```(?:bash|sh|shell|zsh)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Khử tiền tố bash -lc "...", bash -c '...', sh -c "...", etc.
  const prefixRegex = /^(?:bash|sh|zsh)\s+-(?:l?c|e)\s+/i;
  while (prefixRegex.test(cleaned)) {
    cleaned = cleaned.replace(prefixRegex, "").trim();
    // Khử dấu ngoặc kép hoặc nháy đơn bao bọc nếu có sau khi bóc vỏ bash -lc
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))
    ) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  }

  return cleaned;
}

/**
 * Quy tắc: cat <file1> [file2...] hoặc type <file> -> read_file(path) cho từng file
 */
export class CatRule implements IBashCommandRule {
  readonly name = "CatRule";

  /**
 * Kiểm tra xem lệnh bash có khớp với quy tắc đọc file (cat/head/tail) hay không.
 */
  match(cmd: string): boolean {

    const trimmed = cmd.trim();
    // 1. cat <file...>: phải bắt đầu bằng 'cat '
    if (/^cat\s+[^\s|;&]+/i.test(trimmed)) {
      return true;
    }
    // 2. type <file...>: Windows type hoặc fenced command
    if (/^type\s+[^\s|;&]+/i.test(trimmed)) {
      return true;
    }
    return false;
  }

  /**
 * Biên dịch lệnh cat/head/tail thành tool call readFile tương ứng.
 */
  translate(cmd: string): Array<{ name: string; arguments: Record<string, any> }> | { name: string; arguments: Record<string, any> } | null {

    const trimmed = cmd.trim();
    const isCat = /^cat\s+/i.test(trimmed);
    const isType = /^type\s+/i.test(trimmed);
    if (!isCat && !isType) return null;

    // Loại bỏ ngay lập tức nếu dòng chứa các dấu hiệu rõ ràng của câu văn tự nhiên hoặc định nghĩa code
    if (/[=:{};]|\b(?:class|interface|struct|function|let|const|var|là|của|không|hợp|lệ|này|được|cho|với|trong|theo|kết|quả|lỗi)\b/i.test(trimmed)) {
      return null;
    }

    const afterCmd = trimmed.replace(/^(?:cat|type)\s+/i, "").trim();
    const parts = afterCmd.split(/\s+/);
    // Lọc bỏ các flag như -n, -b, -v
    const files = parts.filter(p => !p.startsWith("-")).map(p => p.replace(/['"]/g, "").trim()).filter(Boolean);

    if (files.length === 0) return null;

    /**
     * Kiểm tra một chuỗi ký tự có định dạng giống đường dẫn tệp tin hay không.
     */
    const isPathLike = (s: string): boolean => {

      if (/[^\x20-\x7E]/.test(s)) return false; // Chứa ký tự non-ASCII (tiếng Việt có dấu)
      if (/\.[a-zA-Z0-9_-]+$/.test(s)) return true; // Có đuôi mở rộng file
      if (s.includes("/") || s.includes("\\")) return true; // Có đường dẫn slash
      // Các tên file chuẩn không có đuôi mở rộng
      const wellKnown = new Set(["dockerfile", "makefile", "readme", "license", "procfile", "gemfile", "pom.xml"]);
      if (wellKnown.has(s.toLowerCase())) return true;
      return false;
    };

    // Kiểm tra tính hợp lệ của danh sách file
    const validFiles = files.filter(isPathLike);
    if (validFiles.length === 0) return null;

    // Nếu là 'type': yêu cầu 100% token file phải là path-like để tránh bắt nhầm 'type com.example.Request'
    if (isType && validFiles.length !== files.length) {
      return null;
    }

    // Nếu là 'cat' và có nhiều từ mà quá nửa không phải path-like -> là câu văn tự nhiên
    if (isCat && validFiles.length < files.length && files.length > 2) {
      return null;
    }

    if (validFiles.length === 1) {
      return {
        name: "read_file",
        arguments: { path: validFiles[0] },
      };
    }

    return validFiles.map(filePath => ({
      name: "read_file",
      arguments: { path: filePath },
    }));
  }
}

/**
 * Quy tắc: ls, ls <dir>, dir, dir <dir> -> list_dir(path)
 */
export class LsRule implements IBashCommandRule {
  readonly name = "LsRule";

  /**
 * Kiểm tra xem lệnh bash có khớp với quy tắc liệt kê thư mục (ls) hay không.
 */
  match(cmd: string): boolean {

    return /^(?:ls|dir)(?:\s+.*)?$/i.test(cmd);
  }

  /**
 * Biên dịch lệnh ls thành tool call listDir tương ứng.
 */
  translate(cmd: string): { name: string; arguments: Record<string, any> } | null {

    // Tách các cờ options như -la, -l, -a, /w, etc.
    const parts = cmd.split(/\s+/).slice(1);
    const nonFlagArgs = parts.filter(arg => !arg.startsWith("-") && !arg.startsWith("/"));
    const targetPath = nonFlagArgs.length > 0 ? nonFlagArgs[0].replace(/['"]/g, "").trim() : ".";

    return {
      name: "list_dir",
      arguments: { path: targetPath || "." },
    };
  }
}

/**
 * Quy tắc: grep <keyword> hoặc findstr <keyword> -> grep_code(query)
 */
export class GrepRule implements IBashCommandRule {
  readonly name = "GrepRule";

  /**
 * Kiểm tra xem lệnh bash có khớp với quy tắc tìm kiếm chuỗi (grep/ripgrep) hay không.
 */
  match(cmd: string): boolean {

    return /^(?:grep|findstr)\s+/i.test(cmd);
  }

  /**
 * Biên dịch lệnh grep thành tool call grepCode tương ứng.
 */
  translate(cmd: string): { name: string; arguments: Record<string, any> } | null {

    // Trích xuất keyword từ grep [-opts] "keyword" [path] hoặc grep keyword
    const afterCmd = cmd.replace(/^(?:grep|findstr)\s+/i, "").trim();
    // Bỏ qua các flag thông dụng như -r, -rn, -i, -E, /s, /i
    const cleaned = afterCmd.replace(/(?:-[a-zA-Z]+\s+|\/[a-zA-Z]+\s+)+/g, "").trim();

    // Kiểm tra nếu có chuỗi nháy bao quanh
    const quoteMatch = cleaned.match(/^(["'])(.*?)\1/);
    if (quoteMatch) {
      return {
        name: "grep_code",
        arguments: { query: quoteMatch[2] },
      };
    }

    const parts = cleaned.split(/\s+/);
    if (parts.length > 0 && parts[0]) {
      return {
        name: "grep_code",
        arguments: { query: parts[0] },
      };
    }

    return null;
  }
}

/**
 * Quy tắc: git status -> git_status()
 */
export class GitStatusRule implements IBashCommandRule {
  readonly name = "GitStatusRule";

  /**
 * Kiểm tra xem lệnh bash có phải là git status hay không.
 */
  match(cmd: string): boolean {

    return /^git\s+status(?:\s+.*)?$/i.test(cmd);
  }

  /**
 * Biên dịch lệnh git status thành tool call tương ứng.
 */
  translate(_cmd: string): { name: string; arguments: Record<string, any> } {

    return {
      name: "git_status",
      arguments: {},
    };
  }
}

/**
 * Quy tắc: git diff [file] -> git_diff(path?)
 */
export class GitDiffRule implements IBashCommandRule {
  readonly name = "GitDiffRule";

  /**
 * Kiểm tra xem lệnh bash có phải là git diff hay không.
 */
  match(cmd: string): boolean {

    return /^git\s+diff(?:\s+.*)?$/i.test(cmd);
  }

  /**
 * Biên dịch lệnh git diff thành tool call tương ứng.
 */
  translate(cmd: string): { name: string; arguments: Record<string, any> } {

    const parts = cmd.split(/\s+/).slice(2);
    const nonFlagArgs = parts.filter(arg => !arg.startsWith("-"));
    const path = nonFlagArgs.length > 0 ? nonFlagArgs[0].replace(/['"]/g, "").trim() : undefined;

    return {
      name: "git_diff",
      arguments: path ? { path } : {},
    };
  }
}

/**
 * Quy tắc: find <path> [-name <pattern>] -> search_files hoặc list_dir
 */
export class FindRule implements IBashCommandRule {
  readonly name = "FindRule";

  /**
 * Kiểm tra xem lệnh bash có khớp với quy tắc tìm kiếm tệp (find) hay không.
 */
  match(cmd: string): boolean {

    return /^find\s+[^\s]+/i.test(cmd);
  }

  /**
 * Biên dịch lệnh find thành tool call searchFiles tương ứng.
 */
  translate(cmd: string): { name: string; arguments: Record<string, any> } | null {

    const nameMatch = cmd.match(/^find\s+([^\s]+)(?:\s+-(?:i?name)\s+["']?([^"'\s]+)["']?)?/i);
    if (nameMatch) {
      const targetPath = nameMatch[1].replace(/['"]/g, "");
      const pattern = nameMatch[2];
      if (pattern) {
        return {
          name: "search_files",
          arguments: { pattern, path: targetPath },
        };
      }
      return {
        name: "list_dir",
        arguments: { path: targetPath },
      };
    }
    return null;
  }
}

/**
 * Kiểm tra xem chuỗi có chứa tiền tố shell rõ ràng (bash -lc, bash -c, sh -c, ```bash) hay không
 */
export function hasExplicitShellPrefix(text: string): boolean {

  const trimmed = text.trim();
  return (
    /^(?:bash|sh|zsh)\s+-(?:l?c|e)\s+/i.test(trimmed) ||
    /^```(?:bash|sh|shell|zsh)\b/i.test(trimmed)
  );
}

/**
 * Kiểm tra xem đoạn văn bản đứng trước khối code block có biểu thị ý định
 * hướng dẫn, minh họa hoặc ví dụ cho người dùng tự chạy hay không.
 */
export function isInstructionalOrHypotheticalContext(precedingText: string): boolean {

  if (!precedingText) return false;
  const trimmed = precedingText.trim();
  // Lấy 2 dòng cuối cùng trước code block
  const lines = trimmed.split(/\r?\n/).slice(-2).join(" ");

  const instructionalPatterns = [
    /\b(?:bạn\s+có\s+thể|bạn\s+thử|bạn\s+hãy|bạn\s+chạy|người\s+dùng\s+có\s+thể)\b/i,
    /\b(?:ví\s*dụ|tham\s*khảo|câu\s*lệnh\s*mẫu|lệnh\s*mẫu|cú\s*pháp|gợi\s*ý|hướng\s*dẫn|cách\s*thực\s*hiện|lệnh\s*tương\s*ứng)\b/i,
    /\b(?:nếu\s*muốn|khi\s*cần|chẳng\s*hạn|thử\s*lệnh|trong\s*tài\s*liệu|ở\s*terminal|trên\s*terminal)\b/i,
    /\b(?:you\s+can\s+(?:run|try|execute|use)|for\s+example|e\.g\.|sample\s+command|example\s+usage|reference|syntax)\b/i,
    /\b(?:if\s+you\s+want|syntax|to\s+test\s+this\s+manually|terminal\s+command|corresponding\s+command)\b/i,
    /\b(?:không\s+(?:cần\s+)?thực\s+thi|chỉ\s+minh\s+họa|do\s+not\s+execute)\b/i,
  ];

  return instructionalPatterns.some(pattern => pattern.test(lines));
}

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\b(?:rm|del|rmdir|unlink)\s+/i,
  /\bgit\s+(?:reset|clean|push|restore|revert)\b/i,
  /\bcurl\s+.*-X\s*(?:POST|DELETE|PUT|PATCH)\b/i,
  /\bmvn\s+(?:deploy|release:perform)\b/i,
  /\bdocker\s+(?:system\s+prune|rm|rmi)\b/i,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
];

/**
 * Kiểm tra xem một lệnh có khả năng phá hủy hoặc thay đổi trạng thái nhạy cảm hay không.
 * Các lệnh này TUYỆT ĐỐI không được tự động chạy từ fenced code block thông thường!
 */
export function isDestructiveCommand(cmd: string): boolean {

  return DESTRUCTIVE_COMMAND_PATTERNS.some(pat => pat.test(cmd));
}

/**
 * Lớp điều phối đăng ký và thực thi quy tắc dịch lệnh Bash (Tuân thủ DIP & OCP)
 */
export class BashCommandTranslator {
  private readonly rules: IBashCommandRule[] = [];

  /**
 * Khởi tạo bộ biên dịch lệnh bash với các quy tắc mặc định và tùy chọn mở rộng.
 */
  constructor(customRules?: IBashCommandRule[]) {

    if (customRules && customRules.length > 0) {
      this.rules = [...customRules];
    } else {
      // Đăng ký các rule mặc định
      this.registerRule(new CatRule());
      this.registerRule(new GitStatusRule());
      this.registerRule(new GitDiffRule());
      this.registerRule(new LsRule());
      this.registerRule(new GrepRule());
      this.registerRule(new FindRule());
    }
  }

  /**
 * Đăng ký thêm quy tắc biên dịch lệnh bash mới vào danh sách.
 */
  registerRule(rule: IBashCommandRule): this {

    this.rules.push(rule);
    return this;
  }

  /**
   * Dịch tất cả các dòng lệnh bash sang danh sách Tool Calls theo từng khối ngữ nghĩa:
   * 1. Fenced Code Blocks (```bash, ```sh, ```cmd, ```powershell, ```shell): trích xuất các lệnh executable
   * 2. Standalone Strict Commands: các dòng lệnh đơn độc ngoài code block match chặt chẽ các rule
   * 3. Prose văn bản tự nhiên: tuyệt đối không bị biến thành command, nhưng cũng KHÔNG làm mất command hợp lệ!
   */
  translateAll(rawText: string): Array<{ name: string; arguments: Record<string, any> }> {

    if (!rawText || !rawText.trim()) return [];

    // Nếu văn bản có chứa thẻ XML tool_call hoặc Patch Codex, nhường hoàn toàn cho các detector ưu tiên cao hơn
    if (/<tool[\\_]*call>/i.test(rawText) || /\*{3}\s*Begin Patch/i.test(rawText)) {
      return [];
    }

    const results: Array<{ name: string; arguments: Record<string, any> }> = [];

    // 1. Quét các khối fenced code block có nhãn shell (bash, sh, shell, zsh, powershell, pwsh, cmd)
    const fenceRegex = /```(?:bash|sh|shell|zsh|powershell|pwsh|cmd)\b\s*\r?\n([\s\S]*?)\r?\n```/gi;
    let fenceMatch: RegExpExecArray | null;

    while ((fenceMatch = fenceRegex.exec(rawText)) !== null) {
      // Kiểm tra xem đoạn văn bản đứng trước code block có phải là hướng dẫn / ví dụ minh họa hay không
      const precedingText = rawText.slice(Math.max(0, fenceMatch.index - 200), fenceMatch.index);
      if (isInstructionalOrHypotheticalContext(precedingText)) {
        // Đây là code block minh họa, tài liệu hoặc gợi ý người dùng tự chạy -> Bỏ qua không tự động biến thành tool call
        continue;
      }

      const blockCode = fenceMatch[1];
      const blockLines = blockCode
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith("#"));

      for (const line of blockLines) {
        const stripped = stripShellPrefix(line);
        if (!stripped) continue;

        // Chốt chặn an toàn doanh nghiệp (GPBank): Tuyệt đối không tự động chạy destructive commands từ fenced block
        if (isDestructiveCommand(stripped)) {
          console.warn(`[m365-translator] Bỏ qua lệnh nguy hiểm từ fenced block: ${stripped}`);
          continue;
        }

        let matched = false;
        for (const rule of this.rules) {
          if (rule.match(stripped)) {
            const res = rule.translate(stripped);
            if (res) {
              matched = true;
              if (Array.isArray(res)) results.push(...res);
              else results.push(res);
              break;
            }
          }
        }

        // Trong code block shell, nếu dòng lệnh không match các rule đọc file/git cụ thể thì là run_command
        if (!matched) {
          results.push({
            name: "run_command",
            arguments: { cmd: stripped },
          });
        }
      }
    }

    // 2. Quét các dòng lệnh độc lập ngoài code block
    // Xác định các vùng nằm trong bất kỳ code fence nào (kể cả ``` không phải shell) để bỏ qua
    const allCodeFences = [...rawText.matchAll(/```[\s\S]*?```/g)];
    /**
     * Kiểm tra xem vị trí ký tự (index) có đang nằm bên trong một khối code block (fence) hay không.
     */
    const isInsideAnyFence = (index: number): boolean => {

      return allCodeFences.some(m => index >= m.index && index < m.index + m[0].length);
    };

    const lines = rawText.split(/\r?\n/);
    let charOffset = 0;

    for (const rawLine of lines) {
      const lineStart = charOffset;
      charOffset += rawLine.length + 1; // +1 cho newline

      if (isInsideAnyFence(lineStart)) {
        continue;
      }

      const trimmedLine = rawLine.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) continue;

      const isShellExplicit = hasExplicitShellPrefix(trimmedLine);
      const stripped = stripShellPrefix(trimmedLine);

      let matched = false;
      for (const rule of this.rules) {
        if (rule.match(stripped)) {
          const res = rule.translate(stripped);
          if (res) {
            matched = true;
            if (Array.isArray(res)) results.push(...res);
            else results.push(res);
            break;
          }
        }
      }

      // Ngoài code block: CHỈ chấp nhận run_command khi có tiền tố shell rõ ràng (bash -lc, sh -c...)
      // TUYỆT ĐỐI không biến câu văn tự nhiên trần thành run_command!
      if (!matched && isShellExplicit && stripped) {
        results.push({
          name: "run_command",
          arguments: { cmd: stripped },
        });
      }
    }

    return results;
  }

  /**
   * Thử dịch một dòng hoặc khối lệnh bash sang Tool Call (trả về tool đầu tiên để tương thích ngược)
   */
  translate(rawText: string): { name: string; arguments: Record<string, any> } | null {

    const all = this.translateAll(rawText);
    return all.length > 0 ? all[0] : null;
  }
}
