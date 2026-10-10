
import { randomUUID } from "node:crypto";
import type { OpenAIToolCall } from "../translation/detectors/types";
import { parseStrictM365Response, type M365ProtocolErrorCode } from "../translation/strict-response-parser";
import { truncateToolResult } from "../prompts/assembler";
import { buildM365FormatRetryPrompt } from "../prompts/format-retry";
import { normalizeM365ToolArguments } from "../tools/argument-normalizer";
import { validateM365ToolCall } from "../tools/tool-validator";
import type { CodexTool } from "../../../types";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

/**
 * Giao diện thực thi Tool
 * Tuân thủ Dependency Inversion Principle (DIP)
 */
export interface IToolExecutor {
  execute(name: string, args: Record<string, any>): Promise<string> | string;
}

/**
 * Giao diện gọi Model M365 (trừu tượng hóa Web / CDP / Mock)
 */
export interface IM365ModelClient {
  call(prompt: string, context?: { turnIndex: number; conversationKey?: string }): Promise<string>;
}

export interface AgentMessage {
  role: "user" | "assistant" | "tool_result";
  content: string;
  toolCallId?: string;
  toolName?: string;
  thinking?: string;
  narrative?: string;
  isError?: boolean;
}

export interface AgentLoopRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  perTurnTimeoutMs?: number;
  retryableErrors?: string[];
  maxFormatRetries?: number;
}

export interface AgentLoopOptions {
  maxTurns?: number;
  conversationKey?: string;
  retryOptions?: AgentLoopRetryOptions;
  clientTools?: CodexTool[];
  onTurnStart?: (turnIndex: number, prompt: string) => void;
  onRawResponse?: (turnIndex: number, raw: string) => void;
  onToolCall?: (turnIndex: number, toolCalls: OpenAIToolCall[]) => void;
  onToolResult?: (turnIndex: number, toolName: string, result: string, isError?: boolean) => void;
  onFinalAnswer?: (turnIndex: number, answer: string) => void;
  onTurnRetry?: (turnIndex: number, attempt: number, error: Error, delayMs: number) => void;
  onFormatRetry?: (turnIndex: number, attempt: number, code: string, message: string) => void;
}

export interface AgentLoopResult {
  finalAnswer: string;
  turns: number;
  messages: AgentMessage[];
  status: "completed" | "max_turns_exceeded" | "failed";
  error?: string;
}

type HarnessTranslationResult =
  | { type: "final_answer"; content: string; rawResponse: string }
  | { type: "tool_call"; tool_calls: OpenAIToolCall[]; rawResponse: string };

import { AtomicFileWriter, defaultAtomicFileWriter, type IAtomicFileWriter } from "../tools/atomic-file-writer";

/**
 * Tool Executor mặc định hỗ trợ chạy các công cụ read_file, list_dir, grep_code, git_status, git_diff, run_command, write_file
 */
export class LocalToolExecutor implements IToolExecutor {
  /**
 * Khởi tạo bộ thực thi công cụ cục bộ với thư mục làm việc và công cụ ghi file.
 */
  constructor(
    private readonly workingDir: string = process.cwd(),
    private readonly fileWriter: IAtomicFileWriter = defaultAtomicFileWriter
  ) {
  }

    /**
   * Thực thi công cụ được yêu cầu bởi agent trên môi trường máy cục bộ và trả về kết quả chuẩn hóa.
   */
async execute(name: string, args: Record<string, any>): Promise < string > {

      try {
        switch(name) {
        case "read_file": {
      const filePath = path.resolve(this.workingDir, String(args.path || args.file || ""));
      if (!fs.existsSync(filePath)) {
        return `Lỗi: File không tồn tại tại đường dẫn: ${filePath}`;
      }
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      const startLine = args.start_line ? Math.max(1, parseInt(String(args.start_line), 10)) : 1;
      const endLine = args.end_line ? Math.min(lines.length, parseInt(String(args.end_line), 10)) : lines.length;
      const sliced = lines.slice(startLine - 1, endLine).map((l, i) => `${startLine + i}: ${l}`).join("\n");
      return `[File: ${args.path || args.file} (${startLine}-${endLine}/${lines.length} lines)]\n${sliced}`;
    }

        case "list_dir": {
      const dirPath = path.resolve(this.workingDir, String(args.path || args.dir || "."));
      if (!fs.existsSync(dirPath)) {
        return `Lỗi: Thư mục không tồn tại: ${dirPath}`;
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries.map(e => `${e.isDirectory() ? "[DIR] " : "      "}${e.name}`);
      return `[Thư mục: ${args.path || "."}]\n${items.join("\n")}`;
    }

        case "grep_code": {
      const query = String(args.query || args.pattern || "");
      const targetPath = String(args.path || args.dir || ".");
      try {
        const out = execSync(`grep -rnI "${query.replace(/"/g, '\\"')}" ${targetPath}`, {
          cwd: this.workingDir,
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
        });
        return out.trim() || `Không tìm thấy kết quả cho từ khóa: ${query}`;
      } catch {
        return `Không tìm thấy kết quả cho từ khóa: ${query}`;
      }
    }

        case "git_status": {
      try {
        const out = execSync("git status --short --branch", {
          cwd: this.workingDir,
          encoding: "utf8",
        });
        return out.trim() || "Working tree clean";
      } catch (err: any) {
        return `Lỗi git status: ${err.message}`;
      }
    }

        case "git_diff": {
      try {
        const fileArg = args.path || args.file ? ` "${args.path || args.file}"` : "";
        const out = execSync(`git diff${fileArg}`, {
          cwd: this.workingDir,
          encoding: "utf8",
        });
        return out.trim() || "Không có thay đổi git diff";
      } catch (err: any) {
        return `Lỗi git diff: ${err.message}`;
      }
    }

        case "write_file": {
      const rawPath = String(args.path || args.file || "");
      if (!rawPath.trim()) {
        return `Lỗi: Đường dẫn file không hợp lệ (path bị trống).`;
      }
      const filePath = path.resolve(this.workingDir, rawPath);
      const content = String(args.content ?? "");
      const result = this.fileWriter.writeFile(filePath, content);
      return `Ghi file thành công: ${filePath} (${result.bytesWritten} bytes, sha256: ${result.sha256})`;
    }

        case "run_command": {
      const cmd = String(args.cmd || args.command || "");
      try {
        const out = execSync(cmd, {
          cwd: this.workingDir,
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
        });
        return out.trim();
      } catch (err: any) {
        return `Command error: ${err.stdout || ""}\n${err.stderr || err.message}`;
      }
    }

        default:
    return `Lỗi: Công cụ ${name} không được hỗ trợ trong LocalToolExecutor`;
      }
    } catch (err: any) {
  return `Lỗi thực thi tool ${name}: ${err.message}`;
}
  }
}

/**
 * Lớp điều phối Agent Loop đa bước giữa M365 Copilot và Tool Execution
 * Tuân thủ Open/Closed Principle (OCP) và Single Responsibility (SRP)
 */
export class M365AgentLoop {
  /**
   * Khởi tạo vòng lặp tự trị M365 Agent Loop quản lý luồng trao đổi giữa Codex và Copilot.
   */
  constructor(
    private readonly modelClient: IM365ModelClient,
    private readonly toolExecutor: IToolExecutor = new LocalToolExecutor()
  ) {
  }

  /**
   * Dùng cùng strict parser, argument normalization và validation với production.
   */
  private translateResponse(
    rawResponse: string,
    clientTools: CodexTool[]
  ): HarnessTranslationResult | { protocolError: { code: M365ProtocolErrorCode; message: string } } {
    const parsed = parseStrictM365Response(rawResponse);
    if (parsed.kind === "protocol_error") {
      return { protocolError: { code: parsed.code, message: parsed.message } };
    }
    if (parsed.kind === "final_answer") {
      return {
        type: "final_answer",
        content: parsed.content,
        rawResponse,
      };
    }

    const normalizedCalls = parsed.calls.map(call => {
      const normalized = normalizeM365ToolArguments(call.name, call.arguments);
      return { ...call, name: normalized.name, arguments: normalized.arguments };
    });
    for (const call of normalizedCalls) {
      const validation = validateM365ToolCall(call.name, call.arguments, clientTools);
      if (!validation.ok) {
        return {
          protocolError: {
            code: "INVALID_TOOL_CALL",
            message: `${validation.code}: ${validation.message}`,
          },
        };
      }
    }

    return {
      type: "tool_call",
      rawResponse,
      tool_calls: normalizedCalls.map(call => ({
        id: call.id || `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }

  private isRetryableError(err: unknown, retryableKeywords: string[]): boolean {
    if (!err) return false;
    const msg = String((err as any)?.message || err).toLowerCase();
    return retryableKeywords.some(keyword => msg.includes(keyword.toLowerCase()));
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async callWithTimeout(
    prompt: string,
    context: { turnIndex: number; conversationKey?: string },
    timeoutMs: number
  ): Promise<string> {
    if (!timeoutMs || timeoutMs <= 0) {
      return this.modelClient.call(prompt, context);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Model call timed out after ${timeoutMs}ms (per-turn timeout)`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        this.modelClient.call(prompt, context),
        timeoutPromise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async callWithRetry(
    prompt: string,
    context: { turnIndex: number; conversationKey?: string },
    options: AgentLoopOptions
  ): Promise<string> {
    const retryOpts = options.retryOptions || {};
    const maxRetries = Math.max(1, retryOpts.maxRetries ?? 3);
    const baseDelayMs = retryOpts.baseDelayMs ?? 2000;
    const maxDelayMs = retryOpts.maxDelayMs ?? 30000;
    const timeoutMs = retryOpts.perTurnTimeoutMs ?? 180000;
    const retryableErrors = retryOpts.retryableErrors ?? [
      "timeout",
      "quota",
      "rate_limit",
      "network",
      "fetch",
      "econnreset",
      "etimedout",
      "socket hang up",
      "503",
      "429",
      "502",
      "504",
      "temporarily unavailable",
    ];

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.callWithTimeout(prompt, context, timeoutMs);
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isRetryable = this.isRetryableError(err, retryableErrors);

        if (attempt < maxRetries && isRetryable) {
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
          options.onTurnRetry?.(context.turnIndex, attempt, lastError, delay);
          await this.sleep(delay);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error("M365 Model Call thất bại sau số lần thử lại tối đa");
  }

  /**
   * Khởi chạy vòng lặp Agent đa bước
   */
  async run(initialPrompt: string, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {

    const maxTurns = options.maxTurns ?? 30;
    const messages: AgentMessage[] = [];
    let currentPrompt = initialPrompt;
    let turnCount = 0;

    messages.push({ role: "user", content: initialPrompt });

    while (turnCount < maxTurns) {
      turnCount++;
      options.onTurnStart?.(turnCount, currentPrompt);

      // 1. Gửi prompt cho M365 kèm retry transport và retry protocol tách biệt.
      let rawResponse: string;
      let translation: HarnessTranslationResult | undefined;
      let attemptPrompt = currentPrompt;
      const configuredFormatRetries = options.retryOptions?.maxFormatRetries ?? 3;
      const maxFormatRetries = Number.isFinite(configuredFormatRetries) && configuredFormatRetries >= 0
        ? Math.min(Math.floor(configuredFormatRetries), 10)
        : 3;

      for (let formatAttempt = 0; formatAttempt <= maxFormatRetries; formatAttempt++) {
        try {
          rawResponse = await this.callWithRetry(
            attemptPrompt,
            {
              turnIndex: turnCount,
              conversationKey: options.conversationKey,
            },
            options
          );
        } catch (err: any) {
          const errorMsg = `M365 Model Call thất bại sau khi thử lại: ${err?.message || String(err)}`;
          return {
            finalAnswer: errorMsg,
            turns: turnCount,
            messages,
            status: "failed",
            error: errorMsg,
          };
        }

        options.onRawResponse?.(turnCount, rawResponse);
        const translated = this.translateResponse(rawResponse, options.clientTools || []);
        if (!("protocolError" in translated)) {
          translation = translated;
          break;
        }

        options.onFormatRetry?.(
          turnCount,
          formatAttempt + 1,
          translated.protocolError.code,
          translated.protocolError.message
        );
        if (formatAttempt >= maxFormatRetries) {
          const errorMsg = `[M365 Format Error] Đã hủy response sau ${maxFormatRetries + 1} lần vì sai protocol (${translated.protocolError.code}): ${translated.protocolError.message}`;
          return {
            finalAnswer: errorMsg,
            turns: turnCount,
            messages,
            status: "failed",
            error: errorMsg,
          };
        }
        attemptPrompt = buildM365FormatRetryPrompt(translated.protocolError);
      }

      if (!translation) {
        const errorMsg = "[M365 Format Error] Không nhận được response protocol hợp lệ.";
        return { finalAnswer: errorMsg, turns: turnCount, messages, status: "failed", error: errorMsg };
      }

      // 3. Phân nhánh: Final Answer hay Tool Call
      if (translation.type === "final_answer") {
        options.onFinalAnswer?.(turnCount, translation.content);
        messages.push({
          role: "assistant",
          content: translation.content,
        });

        return {
          finalAnswer: translation.content,
          turns: turnCount,
          messages,
          status: "completed",
        };
      }

      // Xử lý nhánh Tool Call
      const toolCalls = translation.tool_calls;
      options.onToolCall?.(turnCount, toolCalls);
      messages.push({
        role: "assistant",
        content: JSON.stringify({
          tool_calls: toolCalls,
        }),
      });

      // 4. Thực thi từng tool call và thu thập kết quả
      const toolResultsPromptParts: string[] = [];

      for (const call of toolCalls) {
        const { name, arguments: argsJson } = call.function;
        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = JSON.parse(argsJson);
        } catch {
          parsedArgs = { raw: argsJson };
        }

        let rawResult: string;
        let isToolError = false;
        try {
          rawResult = await this.toolExecutor.execute(name, parsedArgs);
          if (
            typeof rawResult === "string" &&
            (rawResult.startsWith("Lỗi:") ||
              rawResult.startsWith("Command error:") ||
              rawResult.startsWith("Error:") ||
              rawResult.includes("[ERROR]"))
          ) {
            isToolError = true;
          }
        } catch (err: any) {
          rawResult = `Lỗi thực thi công cụ ${name}: ${err?.message || String(err)}`;
          isToolError = true;
        }

        const truncatedResult = truncateToolResult(rawResult);

        console.log("\n[TOOL RESULT]");
        console.log(`Tool: ${name} (${call.id})${isToolError ? " [ERROR]" : ""}`);
        console.log(truncatedResult);

        options.onToolResult?.(turnCount, name, truncatedResult, isToolError);
        messages.push({
          role: "tool_result",
          toolCallId: call.id,
          toolName: name,
          content: truncatedResult,
          isError: isToolError,
        });

        if (isToolError) {
          toolResultsPromptParts.push(
            `<tool_result name="${name}" tool_call_id="${call.id}" status="error">\n${truncatedResult}\n</tool_result>\n<system_hint>Thực thi công cụ "${name}" không thành công. Hãy phân tích kỹ thông báo lỗi trên, xem lại đường dẫn/tham số hoặc thử phương án thay thế, tránh lặp lại cùng một thao tác lỗi.</system_hint>`
          );
        } else {
          toolResultsPromptParts.push(
            `<tool_result name="${name}" tool_call_id="${call.id}" status="success">\n${truncatedResult}\n</tool_result>`
          );
        }
      }

      // 5. Chuẩn bị prompt tiếp theo chứa tool result gửi lại cho M365
      currentPrompt = toolResultsPromptParts.join("\n\n");
    }

    // Nếu vượt quá số vòng lặp tối đa
    return {
      finalAnswer: "Vượt quá số lượt thực thi tối đa (max turns exceeded).",
      turns: turnCount,
      messages,
      status: "max_turns_exceeded",
    };
  }
}
