import { createHash } from "node:crypto";
import { dirname, posix, win32 } from "node:path";
import type {
  HostSkillEntry,
  SelectedSkillEntry,
  SkillSourceKind,
  SkillsSettings,
} from "./types";

const SOURCE_ORDER: Record<SkillSourceKind, number> = {
  workspace: 0,
  user: 1,
  unknown: 2,
  system: 3,
};

function resolveSkillDir(filePath: string): string {
  if (!filePath) return "";
  if (filePath.includes("\\") && !filePath.includes("/")) {
    return win32.dirname(filePath);
  }
  return posix.dirname(filePath);
}

/**
 * Biên dịch danh sách Skills khả dụng (dạng siêu tối giản `name -> path`)
 * và các Skill được người dùng kích hoạt trực tiếp qua `/skill` / `$skill`.
 */
export class SkillPromptBuilder {
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
