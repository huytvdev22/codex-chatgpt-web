import { createHash } from "node:crypto";
import { dirname, posix, win32 } from "node:path";
import { skillDirectoryScanner } from "./skill-directory-scanner";
import type {
  HostSkillEntry,
  SelectedSkillEntry,
  SkillSourceKind,
  SkillsSettings,
} from "./types";

const SOURCE_ORDER: Record<SkillSourceKind, number> = {
  workspace: 0,
  custom: 1,
  user: 2,
  unknown: 3,
  system: 4,
};

const SKILL_MENTION_REGEX =
  /(?:^|[\s([{"'`,;:])\$([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})(?=$|[\s.,;:!?)\]}"'`/])/g;

function resolveSkillDir(filePath: string): string {
  if (!filePath) return "";
  if (filePath.includes("\\") && !filePath.includes("/")) {
    return win32.dirname(filePath);
  }
  return posix.dirname(filePath);
}

/**
 * Biên dịch danh sách Skills khả dụng (dạng siêu tối giản `name -> path`),
 * hợp nhất nguồn Codex Host + Custom Skill Directories và tự nạp nội dung `$tên-skill`.
 */
export class SkillPromptBuilder {
  public mergeSkills(
    hostSkills: readonly HostSkillEntry[] | undefined,
    directorySkills: readonly HostSkillEntry[] | undefined,
  ): HostSkillEntry[] {
    const combined: HostSkillEntry[] = [
      ...(hostSkills ?? []),
      ...(directorySkills ?? []),
    ];
    if (combined.length === 0) return [];

    const sorted = [...combined].sort((a, b) => {
      const rankDiff = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
      return rankDiff !== 0 ? rankDiff : 0;
    });

    const seen = new Set<string>();
    const merged: HostSkillEntry[] = [];
    for (const skill of sorted) {
      const key = skill.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(skill);
    }

    return merged;
  }

  public filterHostSkills(
    skills: readonly HostSkillEntry[] | undefined,
    settings: SkillsSettings,
  ): HostSkillEntry[] {
    if (!skills || skills.length === 0) return [];
    if (!settings.enabled || !settings.autoDiscoverHostSkills) return [];

    const disabledSet = new Set(
      settings.disabledSkills.map((item) => item.trim().toLowerCase()).filter(Boolean),
    );

    const filtered = skills.filter((skill) => {
      if (skill.allowImplicitInvocation === false) {
        return false;
      }
      if (!settings.includeSystemSkills && skill.source === "system") {
        return false;
      }
      if (disabledSet.has(skill.name.trim().toLowerCase())) {
        return false;
      }
      return true;
    });

    return [...filtered].sort((a, b) => {
      const rankDiff = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
      return rankDiff !== 0 ? rankDiff : 0;
    });
  }

  public extractExplicitSkillMentions(userInstruction: string | undefined): string[] {
    if (!userInstruction || !userInstruction.includes("$")) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    SKILL_MENTION_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = SKILL_MENTION_REGEX.exec(userInstruction)) !== null) {
      const candidate = (match[1] ?? "").trim();
      if (!candidate) continue;
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(candidate);
    }
    return names;
  }

  public resolveExplicitSkillMentions(
    userInstruction: string | undefined,
    mergedSkills: readonly HostSkillEntry[] | undefined,
    existingSelected: readonly SelectedSkillEntry[] | undefined,
    settings: SkillsSettings,
    readContent: (absolutePath: string) => string | null = (absolutePath) =>
      skillDirectoryScanner.readSkillContent(absolutePath),
  ): SelectedSkillEntry[] {
    const base = [...(existingSelected ?? [])];
    if (!settings.enabled || !userInstruction || !mergedSkills || mergedSkills.length === 0) {
      return base;
    }

    const mentionedNames = this.extractExplicitSkillMentions(userInstruction);
    if (mentionedNames.length === 0) {
      return base;
    }

    const disabledSet = new Set(
      settings.disabledSkills.map((item) => item.trim().toLowerCase()).filter(Boolean),
    );
    const alreadySelected = new Set(
      base.map((item) => item.name.trim().toLowerCase()).filter(Boolean),
    );
    const skillByName = new Map<string, HostSkillEntry>();
    for (const skill of mergedSkills) {
      const key = skill.name.trim().toLowerCase();
      if (key && !skillByName.has(key)) {
        skillByName.set(key, skill);
      }
    }

    for (const rawName of mentionedNames) {
      const key = rawName.toLowerCase();
      if (alreadySelected.has(key) || disabledSet.has(key)) continue;
      const matched = skillByName.get(key);
      if (!matched || !matched.absolutePath) continue;

      const body = readContent(matched.absolutePath);
      if (!body) continue;

      alreadySelected.add(key);
      base.push({
        name: matched.name,
        path: matched.absolutePath,
        body,
      });
    }

    return base;
  }

  public computeAvailableSkillsDigest(
    filteredSkills: readonly HostSkillEntry[],
    settings: SkillsSettings,
  ): string {
    if (!settings.enabled || !settings.autoDiscoverHostSkills || filteredSkills.length === 0) {
      return "";
    }
    const payload = filteredSkills.map((s) => ({
      name: s.name,
      path: s.absolutePath,
    }));
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  }

  public buildAvailableSkillsSection(
    filteredSkills: readonly HostSkillEntry[],
  ): string {
    if (filteredSkills.length === 0) return "";

    const lines = filteredSkills.map(
      (skill) => `- ${skill.name} -> ${skill.absolutePath}`,
    );

    return [
      "[Danh sách Skills khả dụng]:",
      "Khi mình nhắc tới tên skill (như $tên-skill) hoặc yêu cầu dùng một skill trong danh sách dưới đây, bạn dùng công cụ đọc file SKILL.md tại đường dẫn tương ứng (nếu bên trong nhắc tới scripts/ hoặc references/ thì mở rộng theo thư mục chứa SKILL.md đó):",
      ...lines,
    ].join("\n");
  }

  public computeSelectedSkillsDigest(
    selectedSkills: readonly SelectedSkillEntry[] | undefined,
    settings: SkillsSettings,
  ): string {
    if (!settings.enabled || !selectedSkills || selectedSkills.length === 0) {
      return "";
    }
    const active = this.filterSelectedSkills(selectedSkills, settings);
    if (active.length === 0) return "";
    return createHash("sha256")
      .update(JSON.stringify(active))
      .digest("hex")
      .slice(0, 16);
  }

  public buildSelectedSkillsSection(
    selectedSkills: readonly SelectedSkillEntry[] | undefined,
    settings: SkillsSettings,
  ): string {
    if (!settings.enabled || !selectedSkills || selectedSkills.length === 0) {
      return "";
    }
    const active = this.filterSelectedSkills(selectedSkills, settings);
    if (active.length === 0) return "";

    const blocks = active.map((skill) => {
      const skillDir = skill.path ? resolveSkillDir(skill.path) || dirname(skill.path) : "";
      const metaLines = [`- Tên skill: ${skill.name}`];
      if (skill.path) {
        metaLines.push(`- Đường dẫn SKILL.md: ${skill.path}`);
      }
      if (skillDir && skillDir !== ".") {
        metaLines.push(`- Thư mục gốc skill (cho scripts/ hoặc references/ tương đối): ${skillDir}`);
      }
      return `${metaLines.join("\n")}\n\n${skill.body}`;
    });

    return [
      "[Skill được người dùng kích hoạt trực tiếp cho lượt này]:",
      blocks.join("\n\n---\n\n"),
    ].join("\n\n");
  }

  private filterSelectedSkills(
    selectedSkills: readonly SelectedSkillEntry[],
    settings: SkillsSettings,
  ): SelectedSkillEntry[] {
    const disabledSet = new Set(
      settings.disabledSkills.map((item) => item.trim().toLowerCase()).filter(Boolean),
    );
    return selectedSkills.filter(
      (skill) => !disabledSet.has(skill.name.trim().toLowerCase()),
    );
  }
}

export const skillPromptBuilder = new SkillPromptBuilder();
