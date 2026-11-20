import type { CodexRawInputItem } from "../adapters/web/normalization/codex-raw-payload";
import type {
  HostSkillEntry,
  SelectedSkillEntry,
  SkillSourceKind,
} from "./types";

function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinRootAndRelative(rootPath: string, relativePath: string): string {
  const cleanRel = relativePath.replace(/^[./\\]+/, "");
  if (!cleanRel) return rootPath;
  const usesBackslash = rootPath.includes("\\") && !rootPath.includes("/");
  const cleanRoot = rootPath.replace(/[\\/]+$/, "");
  if (usesBackslash) {
    return `${cleanRoot}\\${cleanRel.replace(/\//g, "\\")}`;
  }
  return `${cleanRoot}/${cleanRel.replace(/\\/g, "/")}`;
}

function classifySkillSource(
  absolutePath: string,
  rootPath: string | undefined,
  workspaceCwd: string | undefined,
): SkillSourceKind {
  const normPath = normalizeSlashPath(absolutePath).toLowerCase();
  const normRoot = rootPath ? normalizeSlashPath(rootPath).toLowerCase() : "";

  if (
    normRoot.endsWith("/.system") ||
    normRoot.includes("/.codex/skills/.system") ||
    normPath.includes("/.codex/skills/.system/") ||
    normPath.includes("/.system/")
  ) {
    return "system";
  }

  if (workspaceCwd) {
    const normWs = normalizeSlashPath(workspaceCwd).toLowerCase();
    if (normWs && (normPath === normWs || normPath.startsWith(`${normWs}/`))) {
      return "workspace";
    }
  }

  if (absolutePath.trim().length > 0) {
    return "user";
  }

  return "unknown";
}

/**
 * Parser thuần cho metadata Skills do OpenAI Codex CLI / Desktop gửi qua `/v1/responses`:
 * - Danh sách `host_skills.instructions` (`<skills_instructions>...</skills_instructions>`)
 * - Skill được người dùng kích hoạt trực tiếp qua `/skill` hoặc `$skill` (`skills.selected_skill_instructions`)
 */
export class CodexSkillParser {
  public static extractHostSkills(
    text: string,
    workspaceCwd?: string,
  ): HostSkillEntry[] {
    if (!text || !text.includes("<skills_instructions>")) {
      return [];
    }

    const blocks = [...text.matchAll(/<skills_instructions>([\s\S]*?)<\/skills_instructions>/gi)];
    if (blocks.length === 0) return [];

    const results: HostSkillEntry[] = [];
    const seen = new Set<string>();

    for (const block of blocks) {
      const body = block[1] || "";
      const rootsMap = this.parseSkillRoots(body);

      const availableMatch = body.match(
        /###\s*Available skills\s*\n([\s\S]*?)(?=\n###\s*|$)/i,
      );
      const listSection = availableMatch ? availableMatch[1] : body;
      const lines = listSection.split(/\r?\n/);

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("- ")) continue;

        const withFileMatch = line.match(
          /^-\s+([^:\n]+?)\s*:\s*([\s\S]*?)\s*\(file:\s*([^)\n]+?)\)\s*$/i,
        );
        const nameOnlyFileMatch = !withFileMatch
          ? line.match(/^-\s+([^\s(\n]+)\s*\(file:\s*([^)\n]+?)\)\s*$/i)
          : null;

        let name = "";
        let description = "";
        let shortPath = "";

        if (withFileMatch) {
          name = withFileMatch[1].trim();
          description = withFileMatch[2].trim();
          shortPath = withFileMatch[3].trim();
        } else if (nameOnlyFileMatch) {
          name = nameOnlyFileMatch[1].trim();
          shortPath = nameOnlyFileMatch[2].trim();
        } else {
          continue;
        }

        if (!name || !shortPath) continue;

        const { absolutePath, rootPath } = this.resolveShortPath(shortPath, rootsMap);
        const dedupKey = `${name}::${absolutePath}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        results.push({
          name,
          description,
          shortPath,
          absolutePath,
          source: classifySkillSource(absolutePath, rootPath, workspaceCwd),
        });
      }
    }

    return results;
  }

  public static isSelectedSkillItem(
    item: CodexRawInputItem | Record<string, unknown>,
    text: string,
  ): boolean {
    const meta = (item as { internal_chat_message_metadata_passthrough?: { content_item_kinds?: unknown } })
      ?.internal_chat_message_metadata_passthrough;
    const kinds = Array.isArray(meta?.content_item_kinds)
      ? (meta.content_item_kinds as string[])
      : [];

    if (kinds.includes("skills.selected_skill_instructions")) {
      return true;
    }

    const trimmed = text.trim();
    return (
      trimmed.startsWith("<skill>") &&
      trimmed.endsWith("</skill>") &&
      /<name>[\s\S]*?<\/name>/i.test(trimmed) &&
      /<path>[\s\S]*?<\/path>/i.test(trimmed)
    );
  }

  public static parseSelectedSkill(text: string): SelectedSkillEntry | null {
    if (!text) return null;
    const trimmed = text.trim();
    const skillMatch = trimmed.match(/<skill>([\s\S]*?)<\/skill>/i);
    const inner = skillMatch ? skillMatch[1] : trimmed;

    const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/i);
    const pathMatch = inner.match(/<path>([\s\S]*?)<\/path>/i);
    const name = nameMatch?.[1]?.trim() || "";
    const path = pathMatch?.[1]?.trim() || "";

    if (!name && !path) return null;

    const body = inner
      .replace(/<name>[\s\S]*?<\/name>/i, "")
      .replace(/<path>[\s\S]*?<\/path>/i, "")
      .trim();

    if (!body) return null;

    return {
      name: name || "unnamed-skill",
      path,
      body,
    };
  }

  private static parseSkillRoots(body: string): Map<string, string> {
    const rootsMap = new Map<string, string>();
    const rootsMatch = body.match(/###\s*Skill roots\s*\n([\s\S]*?)(?=\n###\s*|$)/i);
    if (!rootsMatch) return rootsMap;

    for (const rawLine of rootsMatch[1].split(/\r?\n/)) {
      const match = rawLine.trim().match(/^-\s*`?([a-zA-Z0-9_-]+)`?\s*=\s*`?([^`\n]+?)`?\s*$/);
      if (match) {
        rootsMap.set(match[1].trim(), match[2].trim());
      }
    }
    return rootsMap;
  }

  private static resolveShortPath(
    shortPath: string,
    rootsMap: Map<string, string>,
  ): { absolutePath: string; rootPath?: string } {
    const normalizedShort = shortPath.replace(/\\/g, "/");
    const slashIdx = normalizedShort.indexOf("/");
    if (slashIdx > 0) {
      const alias = normalizedShort.slice(0, slashIdx);
      const rootPath = rootsMap.get(alias);
      if (rootPath) {
        const rest = normalizedShort.slice(slashIdx + 1);
        return {
          absolutePath: joinRootAndRelative(rootPath, rest),
          rootPath,
        };
      }
    }
    if (rootsMap.has(shortPath)) {
      const rootPath = rootsMap.get(shortPath)!;
      return { absolutePath: rootPath, rootPath };
    }
    return { absolutePath: shortPath };
  }
}
