import { logFunctionInput } from "../../debug-logger";
import { BasePlatformCommandStrategy } from "./base";
import type { FileRange, WriteFileOptions } from "./types";

/**
 * Chiến lược sinh lệnh tương thích POSIX (macOS, Linux) sử dụng Node.js/Bun runner.
 * (Tuân thủ Open/Closed Principle & Liskov Substitution Principle - SOLID)
 */
export class PosixCommandStrategy extends BasePlatformCommandStrategy {
  readonly platformName = "posix";

    /**
   * Sinh lệnh đọc nội dung file an toàn trong môi trường POSIX (macOS, Linux).
   */
readFile(targetPath: string, range?: FileRange): string {
    logFunctionInput("tools:command-strategies:posix", "readFile", { targetPath, range });
    const file = String(targetPath || "package.json");
    const startLine = range?.startLine ? Math.max(0, range.startLine) : 0;
    const endLine = range?.endLine ? Math.max(0, range.endLine) : 0;

    const script = `const fs=require('fs');try{const f=process.argv[1],raw=fs.readFileSync(f,'utf8');const lines=raw.split(/\\r?\\n/),tot=lines.length;const rStart=parseInt(process.argv[2]||'0',10),rEnd=parseInt(process.argv[3]||'0',10);const isPaged=rStart>0||rEnd>0;const s=rStart>0?Math.max(1,rStart):1;const e=rEnd>0?Math.min(tot,Math.min(rEnd,s+149)):(isPaged?Math.min(tot,s+149):Math.min(tot,150));const slice=lines.slice(s-1,e);const num=slice.map((l,idx)=>(s+idx)+': '+l).join('\\n');console.log('[File: '+f+' ('+s+'-'+e+'/'+tot+' lines)]\\n'+num);if(e<tot){console.log('[NOTE: File continues. To read the next chunk, specify start_line='+(e+1)+', end_line='+Math.min(tot,e+150)+']')}}catch(e){console.error('Cannot read file: '+e.message);process.exit(1)}`;
    return `node -e "${script}" ${this.quoteArg(file)} ${startLine} ${endLine}`;
  }

    /**
   * Sinh lệnh liệt kê danh sách tệp và thư mục trong môi trường POSIX.
   */
listDir(targetPath: string): string {
    logFunctionInput("tools:command-strategies:posix", "listDir", { targetPath });
    const dir = String(targetPath || ".");
    const script = `const fs=require('fs');try{const items=fs.readdirSync(process.argv[1],{withFileTypes:true}).map(e=>e.isDirectory()?e.name+'/':e.name).sort();console.log(items.join('\\n'))}catch(e){console.error('Cannot list dir: '+e.message);process.exit(1)}`;
    return `node -e "${script}" ${this.quoteArg(dir)}`;
  }

    /**
   * Sinh lệnh tìm kiếm tệp tin theo mẫu (pattern) trong môi trường POSIX.
   */
searchFiles(pattern: string, targetPath = "."): string {
    logFunctionInput("tools:command-strategies:posix", "searchFiles", { pattern, targetPath });
    const dir = String(targetPath || ".");
    const pat = String(pattern || "*");
    const script = `const fs=require('fs'),p=require('path');const root=process.argv[1]||'.',pattern=process.argv[2]||'*';const reg=new RegExp(pattern.replace(/\\./g,'\\\\.').replace(/\\*/g,'.*').replace(/\\?/g,'.'),'i');const res=[];function walk(d){if(res.length>=50)return;try{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='node_modules'||e.name==='dist'||e.name==='target')continue;const full=p.join(d,e.name);if(e.isDirectory())walk(full);else if(reg.test(e.name)||reg.test(full))res.push(full);if(res.length>=50)break;}}catch{}}walk(root);console.log(res.join('\\n'));`;
    return `node -e "${script}" ${this.quoteArg(dir)} ${this.quoteArg(pat)}`;
  }

    /**
   * Sinh lệnh tìm kiếm nội dung mã nguồn (grep) trong môi trường POSIX.
   */
grepCode(query: string, targetPath = "."): string {
    logFunctionInput("tools:command-strategies:posix", "grepCode", { query, targetPath });
    const dir = String(targetPath || ".");
    const q = String(query || "");
    const script = `const fs=require('fs'),p=require('path');const root=process.argv[1]||'.',q=process.argv[2]||'';let c=0;function scan(d){if(c>=50)return;try{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='node_modules'||e.name==='dist'||e.name==='target')continue;const full=p.join(d,e.name);if(e.isDirectory())scan(full);else if(/\\.(ts|js|tsx|jsx|json|md|html|css|py|rs|go|java|xml|yml|yaml|toml|sh|bat|cmd|ps1)$/i.test(e.name)){try{const lines=fs.readFileSync(full,'utf8').split('\\n');for(let i=0;i<lines.length;i++){if(lines[i].includes(q)){console.log(full+':'+(i+1)+': '+lines[i].trim());c++;if(c>=50)return;}}}catch{}}}}catch{}}scan(root);`;
    return `node -e "${script}" ${this.quoteArg(dir)} ${this.quoteArg(q)}`;
  }

    /**
   * Sinh lệnh ghi dữ liệu ra tệp tin trong môi trường POSIX.
   */
writeFile(targetPath: string, contentOrBase64: string, options?: WriteFileOptions): string {
    logFunctionInput("tools:command-strategies:posix", "writeFile", { targetPath, contentOrBase64, options });
    const file = String(targetPath || "");
    const stagingPath = options?.stagingPath;

    if (stagingPath) {
      // Cơ chế Staging File an toàn: Không truyền dữ liệu lớn qua CLI (Yêu cầu 7, 8, 9)
      const expLen = options?.expectedLength || 0;
      const expSha = options?.expectedSha256 || "";
      const script = `const fs=require('fs'),p=require('path'),c=require('crypto');const target=process.argv[1],src=process.argv[2],expLen=parseInt(process.argv[3]||'0',10),expSha=process.argv[4]||'';try{const dir=p.dirname(target);fs.mkdirSync(dir,{recursive:true});const buf=fs.readFileSync(src);if(expLen>0&&buf.length!==expLen){console.error('Verification failure: length mismatch '+buf.length+' vs '+expLen);process.exit(1);}const hash=c.createHash('sha256').update(buf).digest('hex');if(expSha&&hash.toLowerCase()!==expSha.toLowerCase()){console.error('Verification failure: sha256 mismatch '+hash+' vs '+expSha);process.exit(1);}const tmp=p.join(dir,'.'+p.basename(target)+'.tmp.'+Date.now()+'.'+Math.random().toString(36).slice(2,8));const fd=fs.openSync(tmp,'w',0o644);fs.writeSync(fd,buf,0,buf.length);fs.fsyncSync(fd);fs.closeSync(fd);const st=fs.statSync(tmp);if(st.size!==buf.length){try{fs.unlinkSync(tmp);}catch{}console.error('Verification failure: tmp size mismatch');process.exit(1);}fs.renameSync(tmp,target);try{fs.unlinkSync(src);}catch{}console.log('Successfully wrote '+target+' ('+buf.length+' bytes, sha256: '+hash+')');}catch(e){console.error('Cannot write file: '+e.message);process.exit(1);}`;
      return `node -e "${script}" ${this.quoteArg(file)} ${this.quoteArg(stagingPath)} ${expLen} ${this.quoteArg(expSha)}`;
    }

    // Cơ chế Base64 Atomic Write với kiểm tra độ dài và SHA-256
    const expLen = options?.expectedLength || 0;
    const expSha = options?.expectedSha256 || "";
    const script = `const fs=require('fs'),p=require('path'),c=require('crypto');const target=process.argv[1],raw=process.argv[2],expLen=parseInt(process.argv[3]||'0',10),expSha=process.argv[4]||'';try{const dir=p.dirname(target);fs.mkdirSync(dir,{recursive:true});const buf=Buffer.from(raw,'base64');if(expLen>0&&buf.length!==expLen){console.error('Verification failure: length mismatch');process.exit(1);}const hash=c.createHash('sha256').update(buf).digest('hex');if(expSha&&hash.toLowerCase()!==expSha.toLowerCase()){console.error('Verification failure: sha256 mismatch');process.exit(1);}const tmp=p.join(dir,'.'+p.basename(target)+'.tmp.'+Date.now()+'.'+Math.random().toString(36).slice(2,8));const fd=fs.openSync(tmp,'w',0o644);fs.writeSync(fd,buf,0,buf.length);fs.fsyncSync(fd);fs.closeSync(fd);const st=fs.statSync(tmp);if(st.size!==buf.length){try{fs.unlinkSync(tmp);}catch{}console.error('Verification failure: tmp size mismatch');process.exit(1);}fs.renameSync(tmp,target);console.log('Successfully wrote '+target);}catch(e){console.error('Cannot write file: '+e.message);process.exit(1);}`;
    return `node -e "${script}" ${this.quoteArg(file)} ${this.quoteArg(contentOrBase64)} ${expLen} ${this.quoteArg(expSha)}`;
  }
}
