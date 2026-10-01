import { BasePlatformCommandStrategy } from "./base";
import type { FileRange } from "./types";

/**
 * Chiến lược sinh lệnh tương thích POSIX (macOS, Linux) sử dụng Node.js/Bun runner.
 * (Tuân thủ Open/Closed Principle & Liskov Substitution Principle - SOLID)
 */
export class PosixCommandStrategy extends BasePlatformCommandStrategy {
  readonly platformName = "posix";

  readFile(targetPath: string, range?: FileRange): string {
    const file = String(targetPath || "package.json");
    const startLine = range?.startLine ? Math.max(0, range.startLine) : 0;
    const endLine = range?.endLine ? Math.max(0, range.endLine) : 0;

    const script = `const fs=require('fs');try{const f=process.argv[1],raw=fs.readFileSync(f,'utf8');const lines=raw.split(/\\r?\\n/),tot=lines.length;const rStart=parseInt(process.argv[2]||'0',10),rEnd=parseInt(process.argv[3]||'0',10);const isPaged=rStart>0||rEnd>0;const s=rStart>0?Math.max(1,rStart):1;const e=rEnd>0?Math.min(tot,rEnd):(isPaged?tot:Math.min(tot,300));const slice=lines.slice(s-1,e);const num=slice.map((l,idx)=>(s+idx)+': '+l).join('\\n');console.log('[File: '+f+' ('+s+'-'+e+'/'+tot+' lines)]\\n'+num)}catch(e){console.error('Cannot read file: '+e.message);process.exit(1)}`;
    return `node -e "${script}" ${this.quoteArg(file)} ${startLine} ${endLine}`;
  }

  listDir(targetPath: string): string {
    const dir = String(targetPath || ".");
    const script = `const fs=require('fs');try{const items=fs.readdirSync(process.argv[1],{withFileTypes:true}).map(e=>e.isDirectory()?e.name+'/':e.name).sort();console.log(items.join('\\n'))}catch(e){console.error('Cannot list dir: '+e.message);process.exit(1)}`;
    return `node -e "${script}" ${this.quoteArg(dir)}`;
  }

  searchFiles(pattern: string, targetPath = "."): string {
    const dir = String(targetPath || ".");
    const pat = String(pattern || "*");
    const script = `const fs=require('fs'),p=require('path');const root=process.argv[1]||'.',pattern=process.argv[2]||'*';const reg=new RegExp(pattern.replace(/\\./g,'\\\\.').replace(/\\*/g,'.*').replace(/\\?/g,'.'),'i');const res=[];function walk(d){if(res.length>=50)return;try{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='node_modules'||e.name==='dist'||e.name==='target')continue;const full=p.join(d,e.name);if(e.isDirectory())walk(full);else if(reg.test(e.name)||reg.test(full))res.push(full);if(res.length>=50)break;}}catch{}}walk(root);console.log(res.join('\\n'));`;
    return `node -e "${script}" ${this.quoteArg(dir)} ${this.quoteArg(pat)}`;
  }

  grepCode(query: string, targetPath = "."): string {
    const dir = String(targetPath || ".");
    const q = String(query || "");
    const script = `const fs=require('fs'),p=require('path');const root=process.argv[1]||'.',q=process.argv[2]||'';let c=0;function scan(d){if(c>=50)return;try{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='node_modules'||e.name==='dist'||e.name==='target')continue;const full=p.join(d,e.name);if(e.isDirectory())scan(full);else if(/\\.(ts|js|tsx|jsx|json|md|html|css|py|rs|go|java|xml|yml|yaml|toml|sh|bat|cmd|ps1)$/i.test(e.name)){try{const lines=fs.readFileSync(full,'utf8').split('\\n');for(let i=0;i<lines.length;i++){if(lines[i].includes(q)){console.log(full+':'+(i+1)+': '+lines[i].trim());c++;if(c>=50)return;}}}catch{}}}}catch{}}scan(root);`;
    return `node -e "${script}" ${this.quoteArg(dir)} ${this.quoteArg(q)}`;
  }

  writeFile(targetPath: string, base64Content: string): string {
    const file = String(targetPath || "");
    const script = `const fs=require('fs'),p=require('path');fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'));console.log('Successfully wrote '+process.argv[1]);`;
    return `node -e "${script}" ${this.quoteArg(file)} ${this.quoteArg(base64Content)}`;
  }
}
