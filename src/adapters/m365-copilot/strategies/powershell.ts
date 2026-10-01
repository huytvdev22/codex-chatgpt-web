import { BasePlatformCommandStrategy } from "./base";
import type { FileRange } from "./types";

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

  private wrapEncoded(script: string): string {
    return `powershell -NoProfile -EncodedCommand ${encodePowerShellScript(script.trim())}`;
  }

  readFile(targetPath: string, range?: FileRange): string {
    const b64Path = Buffer.from(String(targetPath || "package.json"), "utf8").toString("base64");
    const startLine = range?.startLine ? Math.max(0, range.startLine) : 0;
    const endLine = range?.endLine ? Math.max(0, range.endLine) : 0;

    const script = `
$ProgressPreference = 'SilentlyContinue';
$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Path}'));
$rStart = ${startLine};
$rEnd = ${endLine};
if (-not (Test-Path -LiteralPath $p)) {
  [Console]::Error.WriteLine("Cannot read file: File not found: $p");
  exit 1;
}
try {
  $fullPath = (Resolve-Path -LiteralPath $p).Path;
  $lines = [System.IO.File]::ReadAllLines($fullPath, [System.Text.Encoding]::UTF8);
  $tot = $lines.Count;
  $isPaged = ($rStart -gt 0) -or ($rEnd -gt 0);
  $s = if ($rStart -gt 0) { [Math]::Max(1, $rStart) } else { 1 };
  $e = if ($rEnd -gt 0) { [Math]::Min($tot, $rEnd) } elseif ($isPaged) { $tot } else { [Math]::Min($tot, 300) };
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
  Write-Output "[File: $p ($s-$e/$tot lines)]";
  for ($i = $s; $i -le $e; $i++) {
    Write-Output ("{0}: {1}" -f $i, $lines[$i - 1]);
  }
} catch {
  [Console]::Error.WriteLine("Cannot read file: $($_.Exception.Message)");
  exit 1;
}
`;
    return this.wrapEncoded(script);
  }

  listDir(targetPath: string): string {
    const b64Path = Buffer.from(String(targetPath || "."), "utf8").toString("base64");

    const script = `
$ProgressPreference = 'SilentlyContinue';
$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Path}'));
if (-not (Test-Path -LiteralPath $p)) {
  [Console]::Error.WriteLine("Cannot list dir: Directory not found: $p");
  exit 1;
}
try {
  $items = Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | ForEach-Object {
    if ($_.PSIsContainer) { $_.Name + "/" } else { $_.Name }
  } | Sort-Object;
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
  Write-Output ($items -join "\`n");
} catch {
  [Console]::Error.WriteLine("Cannot list dir: $($_.Exception.Message)");
  exit 1;
}
`;
    return this.wrapEncoded(script);
  }

  searchFiles(pattern: string, targetPath = "."): string {
    const b64Root = Buffer.from(String(targetPath || "."), "utf8").toString("base64");
    const b64Pattern = Buffer.from(String(pattern || "*"), "utf8").toString("base64");

    const script = `
$ProgressPreference = 'SilentlyContinue';
$root = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Root}'));
$pat = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Pattern}'));
if (-not (Test-Path -LiteralPath $root)) { exit 0; }
try {
  $regexPat = [regex]::Escape($pat).Replace('\*','.*').Replace('\?','.');
  $reg = [regex]::new($regexPat, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase);
  $res = [System.Collections.Generic.List[string]]::new();
  function Walk-Dir([string]$d) {
    if ($res.Count -ge 50) { return; }
    try {
      $entries = [System.IO.Directory]::GetFileSystemEntries($d);
      foreach ($e in $entries) {
        $name = [System.IO.Path]::GetFileName($e);
        if ($name.StartsWith('.') -or $name -eq 'node_modules' -or $name -eq 'target' -or $name -eq 'dist' -or $name -eq 'bin') { continue; }
        if ([System.IO.Directory]::Exists($e)) {
          Walk-Dir $e;
        } else {
          if ($reg.IsMatch($name) -or $reg.IsMatch($e)) {
            $res.Add($e);
            if ($res.Count -ge 50) { return; }
          }
        }
      }
    } catch {}
  }
  Walk-Dir (Resolve-Path -LiteralPath $root).Path;
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
  Write-Output ($res -join "\`n");
} catch {}
`;
    return this.wrapEncoded(script);
  }

  grepCode(query: string, targetPath = "."): string {
    const b64Root = Buffer.from(String(targetPath || "."), "utf8").toString("base64");
    const b64Query = Buffer.from(String(query || ""), "utf8").toString("base64");

    const script = `
$ProgressPreference = 'SilentlyContinue';
$root = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Root}'));
$query = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Query}'));
if (-not (Test-Path -LiteralPath $root)) { exit 0; }
try {
  $extReg = [regex]::new('\.(ts|js|tsx|jsx|json|md|html|css|py|rs|go|java|xml|yml|yaml|toml|sh|bat|cmd|ps1)$', 'IgnoreCase');
  $count = 0;
  $res = [System.Collections.Generic.List[string]]::new();
  function Scan-Dir([string]$d) {
    if ($count -ge 50) { return; }
    try {
      $entries = [System.IO.Directory]::GetFileSystemEntries($d);
      foreach ($e in $entries) {
        $name = [System.IO.Path]::GetFileName($e);
        if ($name.StartsWith('.') -or $name -eq 'node_modules' -or $name -eq 'target' -or $name -eq 'dist' -or $name -eq 'bin') { continue; }
        if ([System.IO.Directory]::Exists($e)) {
          Scan-Dir $e;
          if ($count -ge 50) { return; }
        } elseif ($extReg.IsMatch($name)) {
          try {
            $lines = [System.IO.File]::ReadAllLines($e, [System.Text.Encoding]::UTF8);
            for ($i = 0; $i -lt $lines.Length; $i++) {
              if ($lines[$i].IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $res.Add(("{0}:{1}: {2}" -f $e, ($i + 1), $lines[$i].Trim()));
                $count++;
                if ($count -ge 50) { return; }
              }
            }
          } catch {}
        }
      }
    } catch {}
  }
  Scan-Dir (Resolve-Path -LiteralPath $root).Path;
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
  Write-Output ($res -join "\`n");
} catch {}
`;
    return this.wrapEncoded(script);
  }

  writeFile(targetPath: string, base64Content: string): string {
    const b64Path = Buffer.from(String(targetPath || ""), "utf8").toString("base64");

    const script = `
$ProgressPreference = 'SilentlyContinue';
$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Path}'));
$bytes = [System.Convert]::FromBase64String('${base64Content}');
try {
  $dir = [System.IO.Path]::GetDirectoryName($p);
  if ($dir -and (-not (Test-Path -LiteralPath $dir))) {
    [System.IO.Directory]::CreateDirectory($dir) | Out-Null;
  }
  [System.IO.File]::WriteAllBytes($p, $bytes);
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
