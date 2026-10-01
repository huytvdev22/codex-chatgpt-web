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

  match(cmd: string): boolean {
    return /^(?:cat|type)\s+[^\s|;&]+/i.test(cmd);
  }

  translate(cmd: string): Array<{ name: string; arguments: Record<string, any> }> | { name: string; arguments: Record<string, any> } | null {
    const parts = cmd.replace(/^(?:cat|type)\s+/i, "").trim().split(/\s+/);
    // Lọc bỏ các flag như -n, -b, -v
    const files = parts.filter(p => !p.startsWith("-")).map(p => p.replace(/['"]/g, "").trim()).filter(Boolean);

    if (files.length === 0) return null;
    if (files.length === 1) {
      return {
        name: "read_file",
        arguments: { path: files[0] },
      };
    }

    return files.map(filePath => ({
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

  match(cmd: string): boolean {
    return /^(?:ls|dir)(?:\s+.*)?$/i.test(cmd);
  }

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

  match(cmd: string): boolean {
    return /^(?:grep|findstr)\s+/i.test(cmd);
  }

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

  match(cmd: string): boolean {
    return /^git\s+status(?:\s+.*)?$/i.test(cmd);
  }

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

  match(cmd: string): boolean {
    return /^git\s+diff(?:\s+.*)?$/i.test(cmd);
  }

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

  match(cmd: string): boolean {
    return /^find\s+[^\s]+/i.test(cmd);
  }

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
 * Lớp điều phối đăng ký và thực thi quy tắc dịch lệnh Bash (Tuân thủ DIP & OCP)
 */
export class BashCommandTranslator {
  private readonly rules: IBashCommandRule[] = [];

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

  registerRule(rule: IBashCommandRule): this {
    this.rules.push(rule);
    return this;
  }

  /**
   * Dịch tất cả các dòng lệnh bash sang danh sách Tool Calls (hỗ trợ đọc nhiều file hoặc chạy chuỗi lệnh)
   */
  translateAll(rawText: string): Array<{ name: string; arguments: Record<string, any> }> {
    if (!rawText || !rawText.trim()) return [];

    const lines = rawText
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith("#") && !l.startsWith("```"));

    if (lines.length === 0) return [];

    const results: Array<{ name: string; arguments: Record<string, any> }> = [];

    for (const line of lines) {
      const isShellExplicit = hasExplicitShellPrefix(line) || hasExplicitShellPrefix(rawText);
      const stripped = stripShellPrefix(line);
      let matched = false;

      for (const rule of this.rules) {
        if (rule.match(stripped)) {
          const res = rule.translate(stripped);
          if (res) {
            matched = true;
            if (Array.isArray(res)) {
              results.push(...res);
            } else {
              results.push(res);
            }
            break;
          }
        }
      }

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
