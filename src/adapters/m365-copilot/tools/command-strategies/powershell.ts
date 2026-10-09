
import { BasePlatformCommandStrategy } from "./base";
import type { FileRange, WriteFileOptions } from "./types";

/**
 * Mã hóa đoạn mã PowerShell thành chuỗi Base64 UTF-16LE tương thích với cờ -EncodedCommand.
 * Phương pháp này loại bỏ triệt để mọi nguy cơ lỗi parsing nháy kép, nháy đơn, ký tự đặc biệt hay biến $var.
 */
export function encodePowerShellScript(script: string): string {

  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Chiến lược sinh lệnh Native cho Windows PowerShell (Tuân thủ Single Responsibility & Dependency Inversion - SOLID)
 * Hoạt động 100% độc lập, không yêu cầu máy cài đặt Node.js hay Bun.
 */
export class PowerShellCommandStrategy extends BasePlatformCommandStrategy {
  readonly platformName = "powershell";

  /**
 * Mã hóa đoạn mã PowerShell sang định dạng Base64 UTF-16LE tương thích với cờ -EncodedCommand.
 */
  private wrapEncoded(script: string): string {

    return `powershell -NoProfile -EncodedCommand ${encodePowerShellScript(script.trim())}`;
  }

  /**
   * Sinh lệnh PowerShell đọc nội dung tệp tin trên hệ điều hành Windows.
   * Sử dụng cú pháp native tinh gọn `Get-Content <file> -Head <count>` để Codex Rust binary nhận diện thành CommandAction::Read (icon 📖).
   */
  readFile(targetPath: string, range?: FileRange): string {

    const file = String(targetPath || "package.json");
    const endLine = range?.endLine ? Math.max(0, range.endLine) : 0;
    const count = endLine > 0 ? endLine : 150;
    return `Get-Content ${this.quoteArg(file)} -Head ${count}`;
  }

  /**
   * Sinh lệnh PowerShell liệt kê tệp và thư mục trên hệ điều hành Windows.
   * Sử dụng alias native `dir <dir> -Name` để Codex Rust binary nhận diện thành CommandAction::ListFiles (icon 📁).
   */
  listDir(targetPath: string): string {

    const dir = String(targetPath || ".");
    return `dir ${this.quoteArg(dir)} -Name`;
  }

  /**
   * Sinh lệnh PowerShell tìm kiếm tệp tin theo mẫu trên hệ điều hành Windows.
   * Sử dụng alias native `dir <dir> -Filter ...` để Codex Rust binary nhận diện thành CommandAction::Search (icon 🔍).
   */
  searchFiles(pattern: string, targetPath = "."): string {

    const dir = String(targetPath || ".");
    const pat = String(pattern || "*");
    return `dir ${this.quoteArg(dir)} -Filter ${this.quoteArg(pat)} -Recurse -Depth 3 -Exclude node_modules,dist,bin,obj -Name`;
  }

  /**
   * Sinh lệnh PowerShell tìm kiếm nội dung mã nguồn trên hệ điều hành Windows.
   * Bắt đầu bằng `Select-String` để Codex Rust binary nhận diện thành CommandAction::Search (icon 🔍).
   */
  grepCode(query: string, targetPath = "."): string {

    const dir = String(targetPath || ".");
    const q = String(query || "");
    return `Select-String -Path "${dir}/*" -Pattern ${this.quoteArg(q)} -Exclude *.min.js,*.lock`;
  }

  /**
 * Sinh lệnh PowerShell ghi dữ liệu ra tệp tin trên hệ điều hành Windows.
 */
  writeFile(targetPath: string, contentOrBase64: string, options?: WriteFileOptions): string {

    const b64Path = Buffer.from(String(targetPath || ""), "utf8").toString("base64");
    const stagingPath = options?.stagingPath;
    const expLen = options?.expectedLength || 0;
    const expSha = options?.expectedSha256 || "";

    if (stagingPath) {
      const b64Staging = Buffer.from(stagingPath, "utf8").toString("base64");
      const script = `
$ProgressPreference = 'SilentlyContinue';
$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Path}'));
$src = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Staging}'));
$expLen = ${expLen};
$expSha = '${expSha}';
try {
  $dir = [System.IO.Path]::GetDirectoryName($p);
  if ($dir -and (-not (Test-Path -LiteralPath $dir))) {
    [System.IO.Directory]::CreateDirectory($dir) | Out-Null;
  }
  $bytes = [System.IO.File]::ReadAllBytes($src);
  if ($expLen -gt 0 -and $bytes.Length -ne $expLen) {
    [Console]::Error.WriteLine("Verification failure: length mismatch $($bytes.Length) vs $expLen");
    exit 1;
  }
  $shaObj = [System.Security.Cryptography.SHA256]::Create();
  $hashBytes = $shaObj.ComputeHash($bytes);
  $actualSha = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLower();
  if ($expSha -and $actualSha -ne $expSha.ToLower()) {
    [Console]::Error.WriteLine("Verification failure: sha256 mismatch $actualSha vs $expSha");
    exit 1;
  }
  $tmpName = "." + [System.IO.Path]::GetFileName($p) + ".tmp." + [System.Guid]::NewGuid().ToString("N");
  $tmpPath = [System.IO.Path]::Combine($dir, $tmpName);
  [System.IO.File]::WriteAllBytes($tmpPath, $bytes);
  $tmpLen = (Get-Item -LiteralPath $tmpPath).Length;
  if ($tmpLen -ne $bytes.Length) {
    Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue;
    [Console]::Error.WriteLine("Verification failure: tmp size mismatch");
    exit 1;
  }
  Move-Item -LiteralPath $tmpPath -Destination $p -Force;
  Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue;
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
  Write-Output "Successfully wrote $p ($($bytes.Length) bytes, sha256: $actualSha)";
} catch {
  [Console]::Error.WriteLine("Cannot write file: $($_.Exception.Message)");
  exit 1;
}
`;
      return this.wrapEncoded(script);
    }

    const script = `
$ProgressPreference = 'SilentlyContinue';
$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Path}'));
$bytes = [System.Convert]::FromBase64String('${contentOrBase64}');
$expLen = ${expLen};
$expSha = '${expSha}';
try {
  $dir = [System.IO.Path]::GetDirectoryName($p);
  if ($dir -and (-not (Test-Path -LiteralPath $dir))) {
    [System.IO.Directory]::CreateDirectory($dir) | Out-Null;
  }
  if ($expLen -gt 0 -and $bytes.Length -ne $expLen) {
    [Console]::Error.WriteLine("Verification failure: length mismatch");
    exit 1;
  }
  $shaObj = [System.Security.Cryptography.SHA256]::Create();
  $hashBytes = $shaObj.ComputeHash($bytes);
  $actualSha = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLower();
  if ($expSha -and $actualSha -ne $expSha.ToLower()) {
    [Console]::Error.WriteLine("Verification failure: sha256 mismatch");
    exit 1;
  }
  $tmpName = "." + [System.IO.Path]::GetFileName($p) + ".tmp." + [System.Guid]::NewGuid().ToString("N");
  $tmpPath = if ($dir) { [System.IO.Path]::Combine($dir, $tmpName) } else { $tmpName };
  [System.IO.File]::WriteAllBytes($tmpPath, $bytes);
  $tmpLen = (Get-Item -LiteralPath $tmpPath).Length;
  if ($tmpLen -ne $bytes.Length) {
    Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue;
    [Console]::Error.WriteLine("Verification failure: tmp size mismatch");
    exit 1;
  }
  Move-Item -LiteralPath $tmpPath -Destination $p -Force;
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
  Write-Output "Successfully wrote $p";
} catch {
  [Console]::Error.WriteLine("Cannot write file: $($_.Exception.Message)");
  exit 1;
}
`;
    return this.wrapEncoded(script);
  }
}
