import type {
  DiscoveredSkillRecord,
  SkillSourceKind,
  SkillsSettings,
} from "./types";

const SOURCE_ORDER: Record<SkillSourceKind, number> = {
  workspace: 0,
  user: 1,
  unknown: 2,
  system: 3,
};

export function filterSkillsForPrompt(
  skills: readonly DiscoveredSkillRecord[],
  settings: SkillsSettings,
): DiscoveredSkillRecord[] {
  if (!settings.enabled || !settings.autoDiscoverHostSkills) return [];
  const disabledSet = new Set(
    settings.disabledSkills.map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  const filtered = skills.filter((skill) => {
    if (!settings.includeSystemSkills && skill.source === "system") return false;
    if (disabledSet.has(skill.name.trim().toLowerCase())) return false;
    return true;
  });
  return [...filtered].sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);
}

export function renderAvailableSkillsPreview(
  skills: readonly DiscoveredSkillRecord[],
  settings: SkillsSettings,
): string {
  const filtered = filterSkillsForPrompt(skills, settings);
  if (filtered.length === 0) return "";

  const lines = filtered.map((skill) => `- ${skill.name} -> ${skill.absolutePath}`);
  return [
    "[Danh sách Skills khả dụng]:",
    "Khi mình nhắc tới tên skill (như $tên-skill) hoặc yêu cầu dùng một skill trong danh sách dưới đây, bạn dùng công cụ đọc file SKILL.md tại đường dẫn tương ứng (nếu bên trong nhắc tới scripts/ hoặc references/ thì mở rộng theo thư mục chứa SKILL.md đó):",
    ...lines,
  ].join("\n");
}
