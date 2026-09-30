import type { CodexTool } from "../../types";

export interface M365RawToolCall {
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface M365MappedToolCall {
  name: string;
  arguments: string;
}

function escapeShellArg(arg: string): string {
  if (!arg) return "''";
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

type ToolHandler = (args: Record<string, any>) => { name: string; args: Record<string, any> };

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  read_file: (args) => {
    const targetPath = args.path || args.file || args.filename || "package.json";
    return {
      name: "exec_command",
      args: { cmd: `cat ${escapeShellArg(String(targetPath))}` },
    };
  },

  list_dir: (args) => {
    const targetPath = args.path || args.dir || ".";
    return {
      name: "exec_command",
      args: { cmd: `ls -la ${escapeShellArg(String(targetPath))}` },
    };
  },

  search_files: (args) => {
    const pattern = args.pattern || args.query || "*";
    const targetPath = args.path || args.dir || ".";
    return {
      name: "exec_command",
      args: {
        cmd: `find ${escapeShellArg(String(targetPath))} -name ${escapeShellArg(String(pattern))} -not -path '*/.*' -not -path '*/node_modules/*' | head -50`,
      },
    };
  },

  grep_code: (args) => {
    const query = args.query || args.pattern || "";
    const targetPath = args.path || args.dir || ".";
    return {
      name: "exec_command",
      args: {
        cmd: `rg -n --max-count 50 ${escapeShellArg(String(query))} ${escapeShellArg(String(targetPath))} 2>/dev/null || grep -rn -m 50 --exclude-dir=node_modules --exclude-dir=.git ${escapeShellArg(String(query))} ${escapeShellArg(String(targetPath))} 2>/dev/null | head -50`,
      },
    };
  },

  git_status: () => {
    return {
      name: "exec_command",
      args: { cmd: "git status -s" },
    };
  },

  git_diff: (args) => {
    const file = args.path || args.file;
    const cmd = file ? `git diff ${escapeShellArg(String(file))}` : "git diff";
    return {
      name: "exec_command",
      args: { cmd },
    };
  },

  run_command: (args) => {
    const cmd = args.cmd || args.command || "";
    return {
      name: "exec_command",
      args: { cmd: String(cmd) },
    };
  },

  write_file: (args) => {
    const targetPath = String(args.path || args.file || "");
    const content = typeof args.content === "string" ? args.content : JSON.stringify(args.content ?? "");
    const base64Content = Buffer.from(content, "utf8").toString("base64");
    // Sử dụng Node.js inline script ghi base64 an toàn tuyệt đối với mọi ký tự đặc biệt
    const nodeScript = `const fs=require('fs'),p=require('path');fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'));console.log('Successfully wrote '+process.argv[1]);`;
    const cmd = `node -e ${escapeShellArg(nodeScript)} ${escapeShellArg(targetPath)} ${escapeShellArg(base64Content)}`;
    return {
      name: "exec_command",
      args: { cmd },
    };
  },
};

/**
 * Lớp điều phối chuyển đổi các công cụ M365 sang Native Codex Tools (Tuân thủ SOLID)
 */
export class M365ToolBridge {
  /**
   * Ánh xạ một tool call nhận được từ M365 Copilot thành dạng tương thích với Client (Codex)
   */
  static mapToolCall(raw: M365RawToolCall, clientTools: CodexTool[] = []): M365MappedToolCall {
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

    // Nếu client đã có sẵn công cụ trùng tên (và không phải read_file), giữ nguyên
    if (hasExactTool && toolName !== "read_file") {
      return {
        name: toolName,
        arguments: JSON.stringify(parsedArgs),
      };
    }

    // Nếu có handler ánh xạ tương ứng
    const handler = TOOL_HANDLERS[toolName];
    if (handler) {
      const mapped = handler(parsedArgs);
      console.log(`[M365 TOOL BRIDGE] Mapped ${toolName} -> ${mapped.name}`);
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
