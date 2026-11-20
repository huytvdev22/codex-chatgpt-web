import type {
  DiscoveredSkillRecord,
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

export function filterSkillsForPrompt(
  skills: readonly DiscoveredSkillRecord[],
  settings: SkillsSettings,
): DiscoveredSkillRecord[] {
  if (!settings.enabled || !settings.autoDiscoverHostSkills) return [];
  const disabledSet = new Set(
    settings.disabledSkills.map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  const seenNames = new Set<string>();
  const filtered: DiscoveredSkillRecord[] = [];
  const sorted = [...skills].sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);

  for (const skill of sorted) {
    if (skill.overriddenBy) continue;
    if (skill.allowImplicitInvocation === false) continue;
    if (!settings.includeSystemSkills && skill.source === "system") continue;
    const key = skill.name.trim().toLowerCase();
    if (!key || disabledSet.has(key) || seenNames.has(key)) continue;
    seenNames.add(key);
    filtered.push(skill);
  }
  return filtered;
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
