import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../config";

/**
 * Resolves the shared Launcher browser-host descriptor without embedding
 * provider-specific ownership in each Web adapter.
 */
export function resolveLauncherDescriptorPath(
  customPath?: string,
  additionalHomeDirectories: readonly string[] = [],
): string | null {
  if (customPath && existsSync(customPath)) return customPath;

  const appHome = process.env.CODEX_CHATGPT_WEB_HOME || getConfigDir();
  const candidates = [
    join(appHome, "runtime", "launcher-browser.json"),
    ...additionalHomeDirectories.map(directory =>
      join(homedir(), directory, "runtime", "launcher-browser.json")
    ),
    join(homedir(), ".codex-m365-copilot", "runtime", "launcher-browser.json"),
    join(homedir(), ".codex-chatgpt-web", "runtime", "launcher-browser.json"),
  ];

  return candidates.find(existsSync) || null;
}
