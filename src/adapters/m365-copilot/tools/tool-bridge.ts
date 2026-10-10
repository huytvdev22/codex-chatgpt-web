
import type { CodexTool } from "../../../types";
import {
  CommandStrategyResolver,
  type PlatformCommandStrategy,
  type StrategyResolveOptions,
} from "./command-strategies";
import { SafeCommandGuard } from "./safe-command-guard";
import { normalizeM365ToolArguments } from "./argument-normalizer";
import { decodeM365Content } from "./content-decoder";
import { validateM365ToolCall } from "./tool-validator";
import { AtomicFileWriter, defaultAtomicFileWriter } from "./atomic-file-writer";

export { SafeCommandGuard } from "./safe-command-guard";
export { normalizeFileContent, type NormalizeFileContentOptions } from "./content-decoder";
export * from "./command-strategies";

export interface M365RawToolCall {
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface M365MappedToolCall {
  name: string;
  arguments: string;
}

export interface MapToolCallOptions extends StrategyResolveOptions {
  strategy?: PlatformCommandStrategy;
}

type ToolHandler = (
  args: Record<string, any>,
  strategy: PlatformCommandStrategy
) => { name: string; args: Record<string, any> };

export interface RequestUserInputOption {
  label: string;
  description?: string;
}

export interface RequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  is_other?: boolean;
  is_secret?: boolean;
  options: RequestUserInputOption[];
}

/**
 * Chuẩn hóa tham số cho request_user_input (Interactive User Interview Wizard)
 * Đảm bảo tương thích hoàn hảo với schema của Codex Rust binary:
 * - Hỗ trợ cả questions dạng mảng lẫn câu hỏi đơn lẻ truyền trực tiếp ở root (question / prompt)
 * - Tự động trích xuất header từ category, topic, title hoặc 3-4 từ đầu của câu hỏi
 * - Chuẩn hóa options: hỗ trợ cả string array lẫn object array { label, description }
 * - Mặc định gán is_other = true để người dùng có ô nhập tự do hoặc Skip
 */
export function normalizeRequestUserInputArgs(args: Record<string, any>): { questions: RequestUserInputQuestion[] } {
  let rawList: any[] = [];
  if (Array.isArray(args.questions)) {
    rawList = args.questions;
  } else if (args.question || args.prompt || args.title || args.message) {
    rawList = [args];
  } else if (Array.isArray(args.items) || Array.isArray(args.choices)) {
    rawList = [args];
  }

  const questions: RequestUserInputQuestion[] = rawList.map((item, idx) => {
    if (typeof item !== "object" || item === null) {
      return {
        id: `q_${idx + 1}`,
        header: `Question ${idx + 1}`,
        question: String(item ?? ""),
        is_other: true,
        is_secret: false,
        options: [],
      };
    }

    const id = String(item.id || item.name || item.key || `q_${idx + 1}`);
    const questionText = String(item.question || item.prompt || item.title || item.message || "");
    let headerText = String(item.header || item.category || item.topic || item.title || "");
    if (!headerText) {
      const words = questionText.trim().split(/\s+/).slice(0, 4).join(" ");
      headerText = words ? (words.length > 25 ? words.slice(0, 25) : words) : `Question ${idx + 1}`;
    }

    const isOther = typeof item.is_other === "boolean" ? item.is_other : true;
    const isSecret = Boolean(item.is_secret || item.secret || false);

    const rawOptions = Array.isArray(item.options)
      ? item.options
      : Array.isArray(item.choices)
        ? item.choices
        : Array.isArray(item.items)
          ? item.items
          : Array.isArray(item.answers)
            ? item.answers
            : [];

    const options: RequestUserInputOption[] = rawOptions.map((opt: any) => {
      if (typeof opt === "string") {
        return {
          label: opt,
          description: "",
        };
      }
      if (typeof opt === "object" && opt !== null) {
        return {
          label: String(opt.label || opt.name || opt.title || opt.text || ""),
          description: String(opt.description || opt.desc || opt.detail || opt.details || ""),
        };
      }
      return {
        label: String(opt ?? ""),
        description: "",
      };
    });

    return {
      id,
      header: headerText,
      question: questionText,
      is_other: isOther,
      is_secret: isSecret,
      options,
    };
  });

  return { questions };
}

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  read_file: (args, strategy) => {
    return SafeCommandGuard.handleReadFile(args, strategy);
  },

  list_dir: (args, strategy) => {
    const targetPath = args.path || args.dir || ".";
    const cmd = strategy.listDir(String(targetPath));
    return {
      name: "exec_command",
      args: { cmd },
    };
  },

  search_files: (args, strategy) => {
    const pattern = args.pattern || args.query || "*";
    const targetPath = args.path || args.dir || ".";
    const cmd = strategy.searchFiles(String(pattern), String(targetPath));
    return {
      name: "exec_command",
      args: { cmd },
    };
  },

  grep_code: (args, strategy) => {
    const query = args.query || args.pattern || "";
    const targetPath = args.path || args.dir || ".";
    const cmd = strategy.grepCode(String(query), String(targetPath));
    return {
      name: "exec_command",
      args: { cmd },
    };
  },

  git_status: (_args, strategy) => {
    return {
      name: "exec_command",
      args: { cmd: strategy.gitStatus() },
    };
  },

  git_diff: (args, strategy) => {
    const file = args.path || args.file;
    const cmd = strategy.gitDiff(file ? String(file) : undefined);
    return {
      name: "exec_command",
      args: { cmd },
    };
  },

  run_command: (args, strategy) => {
    const cmd = String(args.cmd || args.command || "");
    const validation = SafeCommandGuard.validateShellCommand(cmd);
    const platform = strategy?.platformName === "posix" ? "posix" : "powershell";
    const finalCmd = validation.allowed
      ? cmd
      : SafeCommandGuard.createStructuredRefusalCommand(validation, platform);
    return {
      name: "exec_command",
      args: { cmd: strategy.runCommand(finalCmd) },
    };
  },

  write_file: (args, strategy) => {
    const targetPath = String(args.path || args.file || "");
    const content = decodeM365Content(args.content, { encoding: String(args.content_encoding || "plain") });
    const contentBuffer = Buffer.from(content, "utf8");

    // Nếu nội dung dài (> 1024 bytes), sử dụng file staging an toàn để loại bỏ hoàn toàn
    // nguy cơ vượt giới hạn độ dài dòng lệnh (ARG_MAX trên POSIX / 8191 chars trên PowerShell Windows)
    if (contentBuffer.length > 1024) {
      const staging = defaultAtomicFileWriter.createStagingFile(contentBuffer, "codex_wf_");
      const cmd = strategy.writeFile(targetPath, staging.stagingPath, {
        stagingPath: staging.stagingPath,
        expectedLength: staging.bytesWritten,
        expectedSha256: staging.sha256,
      });
      return {
        name: "exec_command",
        args: { cmd },
      };
    }

    // Với nội dung ngắn, giữ Base64 tương thích cho regression tests, có kèm metadata xác thực
    const base64Content = contentBuffer.toString("base64");
    const sha256 = AtomicFileWriter.computeSha256(contentBuffer);
    const cmd = strategy.writeFile(targetPath, base64Content, {
      expectedLength: contentBuffer.length,
      expectedSha256: sha256,
    });
    return {
      name: "exec_command",
      args: { cmd },
    };
  },

  apply_patch: () => {
    throw new Error(
      "[M365 Tool Capability Error] apply_patch requires the client to advertise the native apply_patch tool."
    );
  },

  write_stdin: (args) => {
    const sessionId = typeof args.session_id === "number" ? args.session_id : parseInt(String(args.session_id || 0), 10);
    const chars = typeof args.chars === "string" ? args.chars : "";
    const yieldTimeMs = typeof args.yield_time_ms === "number" ? args.yield_time_ms : undefined;
    const maxTokens = typeof args.max_output_tokens === "number" ? args.max_output_tokens : undefined;
    return {
      name: "write_stdin",
      args: {
        session_id: sessionId,
        chars,
        ...(yieldTimeMs !== undefined ? { yield_time_ms: yieldTimeMs } : {}),
        ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
      },
    };
  },

  view_image: (args) => {
    const targetPath = String(args.path || args.file || args.image_path || "");
    const detail = args.detail === "original" ? "original" : "high";
    return {
      name: "view_image",
      args: {
        path: targetPath,
        detail,
      },
    };
  },

  request_user_input: (args) => {
    const normalized = normalizeRequestUserInputArgs(args);
    return {
      name: "request_user_input",
      args: normalized,
    };
  },

  create_goal: (args) => {
    const objective = String(args.objective || args.goal || "");
    const tokenBudget = typeof args.token_budget === "number" ? args.token_budget : undefined;
    return {
      name: "create_goal",
      args: {
        objective,
        ...(tokenBudget !== undefined ? { token_budget: tokenBudget } : {}),
      },
    };
  },

  update_goal: (args) => {
    const status = String(args.status || "complete");
    return {
      name: "update_goal",
      args: {
        status,
      },
    };
  },

  get_goal: () => {
    return {
      name: "get_goal",
      args: {},
    };
  },

  exec_command: (args, strategy) => {
    const cmd = String(args.cmd || args.command || "");
    const validation = SafeCommandGuard.validateShellCommand(cmd);
    const platform = strategy?.platformName === "posix" ? "posix" : "powershell";
    const finalCmd = validation.allowed
      ? cmd
      : SafeCommandGuard.createStructuredRefusalCommand(validation, platform);
    return {
      name: "exec_command",
      args: {
        ...args,
        cmd: finalCmd,
      },
    };
  },

  // Aliases tương thích cao (phòng trường hợp M365 Copilot gọi không dấu gạch dưới)
  readfile: (args, strategy) => TOOL_HANDLERS.read_file(args, strategy),
  listdir: (args, strategy) => TOOL_HANDLERS.list_dir(args, strategy),
  searchfiles: (args, strategy) => TOOL_HANDLERS.search_files(args, strategy),
  grepcode: (args, strategy) => TOOL_HANDLERS.grep_code(args, strategy),
  gitstatus: (args, strategy) => TOOL_HANDLERS.git_status(args, strategy),
  gitdiff: (args, strategy) => TOOL_HANDLERS.git_diff(args, strategy),
  execcommand: (args, strategy) => TOOL_HANDLERS.exec_command(args, strategy),
  applypatch: (args, strategy) => TOOL_HANDLERS.apply_patch(args, strategy),
  writefile: (args, strategy) => TOOL_HANDLERS.write_file(args, strategy),
  requestuserinput: (args, strategy) => TOOL_HANDLERS.request_user_input(args, strategy),
};

/**
 * Lớp điều phối chuyển đổi các công cụ M365 sang Native Codex Tools (Tuân thủ SOLID & Cross-Platform)
 */
export class M365ToolBridge {
  /**
   * Ánh xạ một tool call nhận được từ M365 Copilot thành dạng tương thích với Client (Codex)
   * Sử dụng PlatformCommandStrategy để sinh câu lệnh phù hợp với shell và hệ điều hành của client.
   */
  static mapToolCall(
    raw: M365RawToolCall,
    clientTools: CodexTool[] = [],
    options?: MapToolCallOptions | PlatformCommandStrategy
  ): M365MappedToolCall {

    const normalized = normalizeM365ToolArguments(raw.name, raw.arguments);
    const toolName = normalized.name;
    let parsedArgs: Record<string, any> = normalized.arguments;
    if (toolName === "write_file") {
      parsedArgs.content = decodeM365Content(parsedArgs.content, {
        encoding: String(parsedArgs.content_encoding || "plain"),
      });
      delete parsedArgs.content_encoding;
    }

    const validation = validateM365ToolCall(toolName, parsedArgs, clientTools);
    if (!validation.ok) {
      throw new Error(`[M365 Tool Validation Error] ${validation.code}: ${validation.message}`);
    }

    const hasExactTool = clientTools.some((t) => t.name === toolName || t.name === raw.name);

    // Xử lý riêng biệt cho apply_patch (công cụ native của Codex để hiển thị diff +X -Y và Undo)
    if (toolName === "apply_patch" || toolName === "applypatch") {
      const patch = String(parsedArgs.input).trim();
      parsedArgs = { ...parsedArgs, input: patch };

      if (!hasExactTool) {
        throw new Error(
          "[M365 Tool Capability Error] Client does not advertise native apply_patch; fallback execution is disabled."
        );
      }

      console.log(`[M365 TOOL BRIDGE] Mapped apply_patch -> native apply_patch (diff widget enabled)`);
      return {
        name: "apply_patch",
        arguments: JSON.stringify({ input: patch }),
      };
    }

    // Xác định strategy theo Dependency Inversion Principle
    let strategy: PlatformCommandStrategy;
    if (options && typeof (options as any).readFile === "function") {
      strategy = options as PlatformCommandStrategy;
    } else {
      const opts = (options || {}) as MapToolCallOptions;
      strategy = opts.strategy || CommandStrategyResolver.resolve(opts);
    }

    // Nếu client đã có sẵn công cụ trùng tên (và không phải read_file hay apply_patch), giữ nguyên
    if (hasExactTool && toolName !== "read_file" && toolName !== "apply_patch") {
      if (toolName === "write_file") {
        // Nội dung đã được decode đúng một lần trước validation.
        parsedArgs.content = String(parsedArgs.content);
      }
      if (toolName === "request_user_input") {
        parsedArgs = normalizeRequestUserInputArgs(parsedArgs);
      }
      if (toolName === "exec_command") {
        const cmd = String(parsedArgs.cmd || parsedArgs.command || "");
        const validation = SafeCommandGuard.validateShellCommand(cmd);
        if (!validation.allowed) {
          const platform = strategy.platformName === "posix" ? "posix" : "powershell";
          parsedArgs.cmd = SafeCommandGuard.createStructuredRefusalCommand(validation, platform);
        } else {
          parsedArgs.cmd = cmd;
        }
      }
      return {
        name: toolName,
        arguments: JSON.stringify(parsedArgs),
      };
    }

    // Nếu có handler ánh xạ tương ứng
    const handler = TOOL_HANDLERS[toolName];
    if (handler) {
      const mapped = handler(parsedArgs, strategy);
      console.log(`[M365 TOOL BRIDGE] Mapped ${toolName} -> ${mapped.name} (strategy: ${strategy.platformName})`);
      return {
        name: mapped.name,
        arguments: JSON.stringify(mapped.args),
      };
    }

    // Mặc định fallback: giữ nguyên
    return {
      name: toolName,
      arguments: JSON.stringify(parsedArgs),
    };
  }
}
