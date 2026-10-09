
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
   * Sử dụng lệnh native `head` / `sed` để Codex Rust binary nhận diện thành CommandAction::Read (icon 📖).
   */
  readFile(targetPath: string, range?: FileRange): string {

    const file = String(targetPath || "package.json");
    const startLine = range?.startLine ? Math.max(0, range.startLine) : 0;
    const endLine = range?.endLine ? Math.max(0, range.endLine) : 0;

    if (startLine > 1) {
      const end = endLine > 0 ? endLine : startLine + 149;
      return `sed -n '${startLine},${end}p' ${this.quoteArg(file)}`;
    }
    const end = endLine > 0 ? endLine : 150;
    return `head -n ${end} ${this.quoteArg(file)}`;
  }

  /**
   * Sinh lệnh liệt kê danh sách tệp và thư mục trong môi trường POSIX.
   * Sử dụng lệnh native `ls -la` để Codex Rust binary nhận diện thành CommandAction::ListFiles (icon 📁).
   */
  listDir(targetPath: string): string {

    const dir = String(targetPath || ".");
    return `ls -la ${this.quoteArg(dir)}`;
  }

  /**
   * Sinh lệnh tìm kiếm tệp tin theo mẫu (pattern) trong môi trường POSIX.
   * Sử dụng lệnh native `find` để Codex Rust binary nhận diện thành CommandAction::Search (icon 🔍).
   */
  searchFiles(pattern: string, targetPath = "."): string {

    const dir = String(targetPath || ".");
    const pat = String(pattern || "*");
    return `find ${this.quoteArg(dir)} -maxdepth 3 -name ${this.quoteArg(pat)} -not -path '*/.*' -not -path '*/node_modules/*'`;
  }

  /**
   * Sinh lệnh tìm kiếm nội dung mã nguồn (grep) trong môi trường POSIX.
   * Sử dụng lệnh native `grep` để Codex Rust binary nhận diện thành CommandAction::Search (icon 🔍).
   */
  grepCode(query: string, targetPath = "."): string {

    const dir = String(targetPath || ".");
    const q = String(query || "");
    return `grep -rn --exclude-dir={node_modules,.git,dist,target,bin,obj} ${this.quoteArg(q)} ${this.quoteArg(dir)}`;
  }

  /**
 * Sinh lệnh ghi dữ liệu ra tệp tin trong môi trường POSIX.
 */
  writeFile(targetPath: string, contentOrBase64: string, options?: WriteFileOptions): string {

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
