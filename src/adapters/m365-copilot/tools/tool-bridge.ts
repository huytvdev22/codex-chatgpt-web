
import type { CodexTool } from "../../../types";
import { SafeCommandGuard } from "./safe-command-guard";
import { normalizeM365ToolArguments } from "./argument-normalizer";
import { decodeM365Content } from "./content-decoder";
import { validateM365ToolCall } from "./tool-validator";
import { buildCodexExecCommandArguments } from "./approval-policy";

export { SafeCommandGuard } from "./safe-command-guard";
export { normalizeFileContent, type NormalizeFileContentOptions } from "./content-decoder";

export interface M365RawToolCall {
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface M365MappedToolCall {
  name: string;
  arguments: string;
}

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

/**
 * Cầu nối native-first giữa M365 Copilot và Codex runtime.
 * Adapter chỉ chuẩn hóa, kiểm tra capability và forward tool call;
 * Codex chịu trách nhiệm thực thi, sandbox, approval và hành vi theo hệ điều hành.
 */
export class M365ToolBridge {
  /**
   * Chuẩn hóa và forward tool call M365 sang đúng native tool do Codex quảng bá.
   */
  static mapToolCall(
    raw: M365RawToolCall,
    clientTools: CodexTool[] = []
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

    // Native-first forwarding: M365 chỉ chuẩn hóa và kiểm tra giao thức, còn Codex runtime
    // chịu trách nhiệm thực thi tool, xử lý hệ điều hành, sandbox, approval và UI lifecycle.
    // Không hạ cấp các semantic tools như read_file/list_dir thành shell command.
    if (!hasExactTool) {
      throw new Error(
        `[M365 Tool Capability Error] Client does not advertise native ${toolName}; platform-specific shell fallback is disabled.`
      );
    }

    // Xử lý riêng biệt cho apply_patch (công cụ native của Codex để hiển thị diff +X -Y và Undo)
    if (toolName === "apply_patch" || toolName === "applypatch") {
      const patch = String(parsedArgs.input).trim();
      parsedArgs = { ...parsedArgs, input: patch };

      console.log(`[M365 TOOL BRIDGE] Mapped apply_patch -> native apply_patch (diff widget enabled)`);
      return {
        name: "apply_patch",
        arguments: JSON.stringify({ input: patch }),
      };
    }

    if (toolName === "request_user_input") {
      parsedArgs = normalizeRequestUserInputArgs(parsedArgs);
    }

    if (toolName === "exec_command" || toolName === "run_command") {
      const cmd = String(parsedArgs.cmd || parsedArgs.command || "");
      const commandValidation = SafeCommandGuard.validateShellCommand(cmd);
      if (!commandValidation.allowed) {
        throw new Error(
          "[M365 Safe Command Error] Command was rejected by the safety policy."
        );
      }
      parsedArgs = buildCodexExecCommandArguments(parsedArgs, cmd);
    }

    console.log(`[M365 TOOL BRIDGE] Forwarded ${toolName} -> native ${toolName}`);
    return {
      name: toolName,
      arguments: JSON.stringify(parsedArgs),
    };
  }
}
