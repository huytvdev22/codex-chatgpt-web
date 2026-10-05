import { M365OutputTranslator, type OpenAIToolCall, type TranslationResult } from "../translation/output-translator";
import { truncateToolResult } from "../prompts/assembler";
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
}

export interface AgentLoopOptions {
  maxTurns?: number;
  conversationKey?: string;
  onTurnStart?: (turnIndex: number, prompt: string) => void;
  onRawResponse?: (turnIndex: number, raw: string) => void;
  onToolCall?: (turnIndex: number, toolCalls: OpenAIToolCall[]) => void;
  onToolResult?: (turnIndex: number, toolName: string, result: string) => void;
  onFinalAnswer?: (turnIndex: number, answer: string) => void;
}

export interface AgentLoopResult {
  finalAnswer: string;
  turns: number;
  messages: AgentMessage[];
  status: "completed" | "max_turns_exceeded" | "failed";
}

import { AtomicFileWriter, defaultAtomicFileWriter, type IAtomicFileWriter } from "../tools/atomic-file-writer";

/**
 * Tool Executor mặc định hỗ trợ chạy các công cụ read_file, list_dir, grep_code, git_status, git_diff, run_command, write_file
 */
export class LocalToolExecutor implements IToolExecutor {
  constructor(
    private readonly workingDir: string = process.cwd(),
    private readonly fileWriter: IAtomicFileWriter = defaultAtomicFileWriter
  ) {}

  async execute(name: string, args: Record<string, any>): Promise<string> {
    try {
      switch (name) {
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
  constructor(
    private readonly modelClient: IM365ModelClient,
    private readonly toolExecutor: IToolExecutor = new LocalToolExecutor(),
    private readonly translator: M365OutputTranslator = new M365OutputTranslator()
  ) {}

  /**
   * Khởi chạy vòng lặp Agent đa bước
   */
  async run(initialPrompt: string, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
    const maxTurns = options.maxTurns ?? 10;
    const messages: AgentMessage[] = [];
    let currentPrompt = initialPrompt;
    let turnCount = 0;

    messages.push({ role: "user", content: initialPrompt });

    while (turnCount < maxTurns) {
      turnCount++;
      options.onTurnStart?.(turnCount, currentPrompt);

      // 1. Gửi prompt cho M365
      const rawResponse = await this.modelClient.call(currentPrompt, {
        turnIndex: turnCount,
        conversationKey: options.conversationKey,
      });

      options.onRawResponse?.(turnCount, rawResponse);

      // 2. Chuyển dịch phản hồi qua Output Translator
      const translation = this.translator.translate(rawResponse);

      // 3. Phân nhánh: Final Answer hay Tool Call
      if (translation.type === "final_answer") {
        options.onFinalAnswer?.(turnCount, translation.content);
        messages.push({ role: "assistant", content: translation.content });

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
        content: JSON.stringify({ tool_calls: toolCalls }),
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

        const rawResult = await this.toolExecutor.execute(name, parsedArgs);
        const truncatedResult = truncateToolResult(rawResult);

        console.log("\n[TOOL RESULT]");
        console.log(`Tool: ${name} (${call.id})`);
        console.log(truncatedResult);

        options.onToolResult?.(turnCount, name, truncatedResult);
        messages.push({
          role: "tool_result",
          toolCallId: call.id,
          toolName: name,
          content: truncatedResult,
        });

        toolResultsPromptParts.push(
          `<tool_result name="${name}" tool_call_id="${call.id}">\n${truncatedResult}\n</tool_result>`
        );
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
