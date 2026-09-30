import type { CodexTool } from "../../types";

export interface M365RawToolCall {
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface M365MappedToolCall {
  name: string;
  arguments: string;
}

/**
 * Bao bọc và thoát chuỗi tham số an toàn tương thích đa nền tảng (Windows cmd/PowerShell, macOS, Linux).
 * Sử dụng nháy kép "..." với ký tự \ để không bị shell Windows (cmd.exe) từ chối.
 */
function quoteArg(arg: string): string {
  if (!arg) return '""';
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

type ToolHandler = (args: Record<string, any>) => { name: string; args: Record<string, any> };

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  read_file: (args) => {
    const targetPath = args.path || args.file || args.filename || "package.json";
    // Universal Node.js reader: tương thích 100% cả Windows (cmd/PowerShell), macOS và Linux
    const script = `const fs=require('fs');try{process.stdout.write(fs.readFileSync(process.argv[1],'utf8'))}catch(e){console.error('Cannot read file: '+e.message);process.exit(1)}`;
    return {
      name: "exec_command",
      args: { cmd: `node -e "${script}" ${quoteArg(String(targetPath))}` },
    };
  },

  list_dir: (args) => {
    const targetPath = args.path || args.dir || ".";
    // Universal Node.js directory lister: không phụ thuộc vào lệnh ls (UNIX) hay dir (Windows)
    const script = `const fs=require('fs');try{const items=fs.readdirSync(process.argv[1],{withFileTypes:true}).map(e=>e.isDirectory()?e.name+'/':e.name).sort();console.log(items.join('\\n'))}catch(e){console.error('Cannot list dir: '+e.message);process.exit(1)}`;
    return {
      name: "exec_command",
      args: { cmd: `node -e "${script}" ${quoteArg(String(targetPath))}` },
    };
  },

  search_files: (args) => {
    const pattern = args.pattern || args.query || "*";
    const targetPath = args.path || args.dir || ".";
    // Universal Node.js file search: tránh hoàn toàn xung đột lệnh find.exe của Windows System32
    const script = `const fs=require('fs'),p=require('path');const root=process.argv[1]||'.',pattern=process.argv[2]||'*';const reg=new RegExp(pattern.replace(/\\./g,'\\\\.').replace(/\\*/g,'.*').replace(/\\?/g,'.'),'i');const res=[];function walk(d){if(res.length>=50)return;try{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='node_modules')continue;const full=p.join(d,e.name);if(e.isDirectory())walk(full);else if(reg.test(e.name)||reg.test(full))res.push(full);if(res.length>=50)break;}}catch{}}walk(root);console.log(res.join('\\n'));`;
    return {
      name: "exec_command",
      args: { cmd: `node -e "${script}" ${quoteArg(String(targetPath))} ${quoteArg(String(pattern))}` },
    };
  },

  grep_code: (args) => {
    const query = args.query || args.pattern || "";
    const targetPath = args.path || args.dir || ".";
    // Universal Node.js code scanner: quét dòng mã nguồn nhanh chóng, an toàn trên mọi hệ điều hành
    const script = `const fs=require('fs'),p=require('path');const root=process.argv[1]||'.',q=process.argv[2]||'';let c=0;function scan(d){if(c>=50)return;try{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='node_modules')continue;const full=p.join(d,e.name);if(e.isDirectory())scan(full);else if(/\\.(ts|js|tsx|jsx|json|md|html|css|py|rs|go|java|xml|yml|yaml|toml|sh|bat|cmd|ps1)$/i.test(e.name)){try{const lines=fs.readFileSync(full,'utf8').split('\\n');for(let i=0;i<lines.length;i++){if(lines[i].includes(q)){console.log(full+':'+(i+1)+': '+lines[i].trim());c++;if(c>=50)return;}}}catch{}}}}catch{}}scan(root);`;
    return {
      name: "exec_command",
      args: { cmd: `node -e "${script}" ${quoteArg(String(targetPath))} ${quoteArg(String(query))}` },
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
    const cmd = file ? `git diff ${quoteArg(String(file))}` : "git diff";
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
    let content = typeof args.content === "string" ? args.content : JSON.stringify(args.content ?? "");
    // Tự động chuẩn hóa nếu nội dung không có dấu xuống dòng thực tế nhưng lại bị double-escaped thành text \n
    if (!content.includes("\n") && content.includes("\\n")) {
      content = content.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
    }
    const base64Content = Buffer.from(content, "utf8").toString("base64");
    // Nháy kép bên ngoài, nháy đơn bên trong, truyền path và base64 qua process.argv
    const script = `const fs=require('fs'),p=require('path');fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'));console.log('Successfully wrote '+process.argv[1]);`;
    const cmd = `node -e "${script}" ${quoteArg(targetPath)} ${quoteArg(base64Content)}`;
    return {
      name: "exec_command",
      args: { cmd },
    };
  },
};

/**
 * Lớp điều phối chuyển đổi các công cụ M365 sang Native Codex Tools (Tuân thủ SOLID & Cross-Platform)
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
