import { logFunctionInput } from "../../debug-logger";
import type { FileRange, PlatformCommandStrategy, WriteFileOptions } from "./types";

/**
 * Lớp cơ sở trừu tượng cho PlatformCommandStrategy (Tuân thủ Liskov Substitution Principle & DRY - SOLID)
 * Cung cấp cài đặt mặc định cho các công cụ Git và shell chung.
 */
export abstract class BasePlatformCommandStrategy implements PlatformCommandStrategy {
  abstract readonly platformName: string;

  abstract readFile(targetPath: string, range?: FileRange): string;
  abstract listDir(targetPath: string): string;
  abstract searchFiles(pattern: string, targetPath?: string): string;
  abstract grepCode(query: string, targetPath?: string): string;
  abstract writeFile(targetPath: string, contentOrBase64: string, options?: WriteFileOptions): string;

    /**
   * Thực hiện xử lý BasePlatformCommandStrategy.gitStatus cho quy trình M365 Copilot Adapter.
   */
gitStatus(): string {
    logFunctionInput("tools:command-strategies:base", "gitStatus");
    return "git status -s";
  }

    /**
   * Thực hiện xử lý BasePlatformCommandStrategy.gitDiff cho quy trình M365 Copilot Adapter.
   */
gitDiff(targetPath?: string): string {
    logFunctionInput("tools:command-strategies:base", "gitDiff", { targetPath });
    const file = targetPath ? String(targetPath).trim() : "";
    return file ? `git diff ${this.quoteArg(file)}` : "git diff";
  }

    /**
   * Thực hiện xử lý BasePlatformCommandStrategy.runCommand cho quy trình M365 Copilot Adapter.
   */
runCommand(cmd: string): string {
    logFunctionInput("tools:command-strategies:base", "runCommand", { cmd });
    return String(cmd || "");
  }

  /**
   * Bao bọc chuỗi tham số an toàn đa nền tảng bằng nháy kép.
   */
  protected quoteArg(arg: string): string {
    logFunctionInput("tools:command-strategies:base", "quoteArg", { arg });
    if (!arg) return '""';
    return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
}
