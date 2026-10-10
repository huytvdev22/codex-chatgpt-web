import type { PlatformCommandStrategy } from "./command-strategies/types";

/**
 * Tạo fallback command chỉ khi Codex client không advertise native apply_patch.
 * Command phải giữ nguyên exit code; tuyệt đối không chuyển lỗi patch thành thành công giả.
 */
export function createApplyPatchFallbackCommand(
  patch: string,
  strategy: PlatformCommandStrategy
): string {
  const base64Patch = Buffer.from(patch, "utf8").toString("base64");
  if (strategy.platformName === "powershell") {
    const script = `
$command = Get-Command apply_patch -ErrorAction SilentlyContinue;
if (-not $command) {
  [Console]::Error.WriteLine('Native apply_patch command is unavailable.');
  exit 127;
}
$patch = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64Patch}'));
$patch | & $command.Source;
exit $LASTEXITCODE;
`;
    const encoded = Buffer.from(script.trim(), "utf16le").toString("base64");
    return `powershell -NoProfile -EncodedCommand ${encoded}`;
  }

  return `command -v apply_patch >/dev/null 2>&1 || { echo 'Native apply_patch command is unavailable.' >&2; exit 127; }; node -e "process.stdout.write(Buffer.from(process.argv[1],'base64'))" "${base64Patch}" | apply_patch`;
}
