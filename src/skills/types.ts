export type SkillSourceKind = "workspace" | "user" | "system" | "unknown";

export interface HostSkillEntry {
  name: string;
  description: string;
  shortPath: string;
  absolutePath: string;
  source: SkillSourceKind;
}

export interface SelectedSkillEntry {
  name: string;
  path: string;
  body: string;
}

export interface SkillsSettings {
  version: 1;
  enabled: boolean;
  autoDiscoverHostSkills: boolean;
  includeSystemSkills: boolean;
  disabledSkills: string[];
  updatedAt: string | null;
}

export interface DiscoveredSkillRecord {
  name: string;
  description: string;
  absolutePath: string;
  source: SkillSourceKind;
  lastSeenAt: string;
}

export function createDefaultSkillsSettings(): SkillsSettings {
  return {
    version: 1,
    enabled: true,
    autoDiscoverHostSkills: true,
    includeSystemSkills: false,
    disabledSkills: [],
    updatedAt: null,
  };
}
