import type { CodexTool } from "../../types";
import {
  CommandStrategyResolver,
  type PlatformCommandStrategy,
  type StrategyResolveOptions,
} from "./strategies";

export * from "./strategies";

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

/**
 * Chuẩn hóa nội dung mã nguồn trước khi ghi file (Tuân thủ Single Responsibility Principle - SOLID):
 * 1. Khôi phục toàn bộ các ký tự bị Turndown/Markdown vô tình escape trong code:
 *    - Dấu ngoặc vuông: \[ -> [, \] -> ]
 *    - Dấu ngoặc nhọn: \{ -> {, \} -> }
 *    - Phép toán và ký tự đặc biệt: \* -> *, \_ -> _, \~ -> ~
 * 2. Khử triệt để dấu gạch chéo thừa ở dòng trống (dòng chỉ có khoảng trắng và dấu \)
 * 3. Khử triệt để dấu gạch chéo thừa ở cuối mỗi dòng (kể cả khi có trailing spaces trước newline)
 * 4. Khử dấu gạch chéo thừa trước literal \n
 * 5. Tự động chuyển đổi các ký tự literal \n, \r, \t thành ký tự điều khiển thực tế khi cần
 * 6. Khử dấu gạch chéo ở cuối file
 */
export function normalizeFileContent(content: string, unescapeNewlines = true): string {
  if (!unescapeNewlines || typeof content !== "string") {
    return content;
  }

  let result = content;

  // 1. Khôi phục các ký tự bị Turndown/Markdown escape trong mã nguồn (\[, \], \{, \}, \*, \_, \~)
  result = result.replace(/\\([\[\]{}*_~])/g, "$1");

  // 2. Khử dấu gạch chéo thừa ở dòng trống (dòng chỉ chứa khoảng trắng và dấu \)
  result = result.replace(/^[ \t]*\\+[ \t]*(\r?\n|$)/gm, "$1");

  // 3. Khử dấu gạch chéo thừa ở cuối mỗi dòng (cho phép khoảng trắng trước và sau \, hỗ trợ cả CRLF và LF)
  result = result.replace(/\\+[ \t]*(\r?\n)/g, "$1");

  // 4. Khử dấu gạch chéo thừa trước literal \n
  result = result.replace(/\\+[ \t]*\\n/g, "\\n");

  // 5. Nếu chuỗi chứa literal \n, chuyển đổi thành ký tự điều khiển thực tế
  if (result.includes("\\n")) {
    result = result.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  }

  // 6. Quét lại lần nữa để khử bất kỳ trailing backslash nào sau khi bung literal \n
  result = result.replace(/\\+[ \t]*(\r?\n)/g, "$1");

  // 7. Khử dấu \ ở cuối file nếu dòng cuối cùng kết thúc bằng \
  result = result.replace(/\\+[ \t]*$/g, "");

  return result;
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  read_file: (args, strategy) => {
    const targetPath = args.path || args.file || args.filename || "package.json";
    const startLine = parseInt(String(args.start_line || args.start || 0), 10) || 0;
    const endLine = parseInt(String(args.end_line || args.end || 0), 10) || 0;

    const cmd = strategy.readFile(String(targetPath), { startLine, endLine });
    return {
      name: "exec_command",
      args: { cmd },
    };
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
    const cmd = args.cmd || args.command || "";
    return {
      name: "exec_command",
      args: { cmd: strategy.runCommand(String(cmd)) },
    };
  },

  write_file: (args, strategy) => {
    const targetPath = String(args.path || args.file || "");
    const rawContent = typeof args.content === "string" ? args.content : JSON.stringify(args.content ?? "");
    // Cho phép AI quyết định khi nào cần unescape ký tự xuống dòng (mặc định là true nếu không bị cấm)
    const shouldUnescape = args.unescape_newlines !== false && args.unescape !== false;
    const content = normalizeFileContent(rawContent, shouldUnescape);
    const base64Content = Buffer.from(content, "utf8").toString("base64");
    const cmd = strategy.writeFile(targetPath, base64Content);
    return {
      name: "exec_command",
      args: { cmd },
    };
  },

  apply_patch: (args) => {
    const rawPatch = typeof args === "string" ? args : (args.input || args.patch || args.content || "");
    const base64Patch = Buffer.from(String(rawPatch), "utf8").toString("base64");
    return {
      name: "exec_command",
      args: { cmd: `echo ${base64Patch} | base64 -d | git apply --whitespace=nowarn - || true` },
    };
  },
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
    const toolName = raw.name;
    let parsedArgs: Record<string, any> = {};

    if (typeof raw.arguments === "string") {
      try {
        parsedArgs = JSON.parse(raw.arguments);
      } catch {
        parsedArgs = {};
      }
    } else if (raw.arguments && typeof raw.arguments === "object") {
      parsedArgs = raw.arguments as Record<string, any>;
    }

    const hasExactTool = clientTools.some((t) => t.name === toolName);

    // Xử lý riêng biệt cho apply_patch (công cụ native của Codex để hiển thị diff +X -Y và Undo)
    if (toolName === "apply_patch") {
      const rawPatch = typeof parsedArgs === "string"
        ? parsedArgs
        : (parsedArgs.input || parsedArgs.patch || parsedArgs.content || "");
      let patch = String(rawPatch)
        .replaceAll("\\*", "*")
        .replaceAll("\\_", "_")
        .replaceAll("\\[", "[")
        .replaceAll("\\]", "]")
        .replaceAll("\\{", "{")
        .replaceAll("\\}", "}");

      // Nếu chứa literal \n thì chuyển sang ký tự xuống dòng thực tế
      if (patch.includes("\\n") && !patch.includes("\n")) {
        patch = patch.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
      }
      patch = patch.replace(/\\+[ \t]*(\r?\n)/g, "$1").trim();

      const beginIdx = patch.indexOf("*** Begin Patch");
      if (beginIdx >= 0) patch = patch.slice(beginIdx);
      const endIdx = patch.lastIndexOf("*** End Patch");
      if (endIdx >= 0) patch = patch.slice(0, endIdx + "*** End Patch".length);
      else if (!patch.endsWith("*** End Patch")) patch = `${patch}\n*** End Patch`;

      if (hasExactTool) {
        console.log(`[M365 TOOL BRIDGE] Mapped apply_patch -> native apply_patch (diff widget enabled)`);
        return {
          name: "apply_patch",
          arguments: JSON.stringify({ input: patch }),
        };
      }
    }

    // Nếu client đã có sẵn công cụ trùng tên (và không phải read_file hay apply_patch), giữ nguyên
    if (hasExactTool && toolName !== "read_file" && toolName !== "apply_patch") {
      return {
        name: toolName,
        arguments: JSON.stringify(parsedArgs),
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
