import type { CodexTool } from "../../../../types";
import type { RawToolCallDto } from "../dto/raw-tool-call.dto";
import type { MappedToolCallDto } from "../dto/mapped-tool-call.dto";
import type {
  RequestUserInputOptionDto,
  RequestUserInputQuestionDto,
} from "../dto/request-user-input.dto";
import type { IToolBridge } from "../contracts/tool-bridge.interface";
import { ToolArgumentNormalizer } from "./argument-normalizer";
import { ToolContentDecoder } from "./content-decoder";
import { ToolCallValidator } from "./tool-validator";
import { SafeCommandGuard } from "./safe-command-guard";
import { ToolApprovalPolicy } from "./approval-policy";

/**
 * Cầu nối công cụ chuẩn hóa giữa Web Chat và Codex runtime.
 * Adapter chuẩn hóa tên công cụ, kiểm tra capability và forward tool call;
 * Codex chịu trách nhiệm thực thi, sandbox, approval và hành vi hệ điều hành.
 */
export class BaseToolBridge implements IToolBridge {
  public mapToolCall(
    raw: RawToolCallDto,
    clientTools: CodexTool[] = []
  ): MappedToolCallDto {
    return BaseToolBridge.mapToolCall(raw, clientTools);
  }

  public static normalizeRequestUserInputArgs(args: Record<string, any>): { questions: RequestUserInputQuestionDto[] } {
    let rawList: any[] = [];
    if (Array.isArray(args.questions)) {
      rawList = args.questions;
    } else if (args.question || args.prompt || args.title || args.message) {
      rawList = [args];
    } else if (Array.isArray(args.items) || Array.isArray(args.choices)) {
      rawList = [args];
    }

    const questions: RequestUserInputQuestionDto[] = rawList.map((item, idx) => {
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

      const options: RequestUserInputOptionDto[] = rawOptions.map((opt: any) => {
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

  public static mapToolCall(
    raw: RawToolCallDto,
    clientTools: CodexTool[] = []
  ): MappedToolCallDto {
    const normalized = ToolArgumentNormalizer.normalizeToolArguments(raw.name, raw.arguments);
    const toolName = normalized.name;
    let parsedArgs: Record<string, any> = normalized.arguments;

    if (toolName === "write_file") {
      parsedArgs.content = ToolContentDecoder.decodeContent(parsedArgs.content, {
        encoding: String(parsedArgs.content_encoding || "plain"),
      });
      delete parsedArgs.content_encoding;
    }

    const validation = ToolCallValidator.validateToolCall(toolName, parsedArgs, clientTools);
    if (!validation.ok) {
      throw new Error(`[Tool Validation Error] ${validation.code}: ${validation.message}`);
    }

    const hasExactTool = clientTools.some((t) => t.name === toolName || t.name === raw.name);
    if (!hasExactTool) {
      throw new Error(
        `[Tool Capability Error] Client does not advertise native ${toolName}; platform-specific shell fallback is disabled.`
      );
    }

    if (toolName === "apply_patch" || toolName === "applypatch") {
      const patch = String(parsedArgs.input).trim();
      parsedArgs = { ...parsedArgs, input: patch };

      console.log(`[TOOL BRIDGE] Mapped apply_patch -> native apply_patch (diff widget enabled)`);
      return {
        name: "apply_patch",
        arguments: JSON.stringify({ input: patch }),
      };
    }

    if (toolName === "request_user_input") {
      parsedArgs = this.normalizeRequestUserInputArgs(parsedArgs);
    }

    if (toolName === "exec_command" || toolName === "run_command") {
      const cmd = String(parsedArgs.cmd || parsedArgs.command || "");
      const commandValidation = SafeCommandGuard.validateShellCommand(cmd);
      if (!commandValidation.allowed) {
        throw new Error(
          "[Safe Command Error] Command was rejected by the safety policy."
        );
      }
      parsedArgs = ToolApprovalPolicy.buildCodexExecCommandArguments(parsedArgs, cmd);
    }

    console.log(`[TOOL BRIDGE] Forwarded ${toolName} -> native ${toolName}`);
    return {
      name: toolName,
      arguments: JSON.stringify(parsedArgs),
    };
  }
}
