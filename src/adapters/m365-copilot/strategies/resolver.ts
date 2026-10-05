import { logFunctionInput } from "../debug-logger";
import type { PlatformCommandStrategy } from "./types";
import { PowerShellCommandStrategy } from "./powershell";
import { PosixCommandStrategy } from "./posix";

export interface StrategyResolveOptions {
  shell?: string;
  platform?: NodeJS.Platform;
  customStrategy?: PlatformCommandStrategy;
}

/**
 * Bộ điều phối chiến lược (Tuân thủ Open/Closed & Dependency Inversion Principle - SOLID)
 * Cho phép tự động phát hiện shell/OS hoặc đăng ký chiến lược thực thi mới.
 */
export class CommandStrategyResolver {
  private static customStrategies = new Map<string, PlatformCommandStrategy>();

  /**
   * Đăng ký một chiến lược tùy biến mới (Open for extension).
   */
  static registerStrategy(name: string, strategy: PlatformCommandStrategy): void {
    logFunctionInput("strategies:resolver", "registerStrategy", { name, strategy });
    this.customStrategies.set(name.toLowerCase(), strategy);
  }

  /**
   * Giải quyết và trả về chiến lược thực thi phù hợp nhất cho ngữ cảnh hiện tại.
   */
  static resolve(options?: StrategyResolveOptions): PlatformCommandStrategy {
    logFunctionInput("strategies:resolver", "resolve", { options });
    if (options?.customStrategy) {
      return options.customStrategy;
    }

    const shell = (options?.shell || "").trim().toLowerCase();
    if (shell) {
      if (this.customStrategies.has(shell)) {
        return this.customStrategies.get(shell)!;
      }
      if (shell === "powershell" || shell === "pwsh") {
        return new PowerShellCommandStrategy();
      }
      if (shell === "bash" || shell === "zsh" || shell === "sh") {
        return new PosixCommandStrategy();
      }
    }

    const platform = options?.platform || process.platform;
    if (platform === "win32") {
      return new PowerShellCommandStrategy();
    }

    return new PosixCommandStrategy();
  }
}
