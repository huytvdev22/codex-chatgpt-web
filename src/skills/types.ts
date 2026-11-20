import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SkillSourceKind = "workspace" | "custom" | "user" | "system" | "unknown";

export interface SkillDirectoryEntry {
  path: string;
  enabled: boolean;
}

export interface ScannedSkillDirectory {
  path: string;
  resolvedPath: string;
  enabled: boolean;
  exists: boolean;
  skillCount: number;
  error: string | null;
}

export interface HostSkillEntry {
  name: string;
  description: string;
  shortPath: string;
  absolutePath: string;
  source: SkillSourceKind;
  directoryPath?: string;
  allowImplicitInvocation?: boolean;
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
  skillDirectories: SkillDirectoryEntry[];
  updatedAt: string | null;
}

export interface DiscoveredSkillRecord {
  name: string;
  description: string;
  absolutePath: string;
  source: SkillSourceKind;
  lastSeenAt: string;
  directoryPath?: string;
  allowImplicitInvocation?: boolean;
  overriddenBy?: SkillSourceKind | null;
}

export function getDefaultSkillDirectories(): SkillDirectoryEntry[] {
  const defaultCodexHome = resolve(join(homedir(), ".codex"));
  const envCodexHome = process.env.CODEX_HOME?.trim();
  if (envCodexHome && resolve(envCodexHome) !== defaultCodexHome) {
    return [{ path: join(envCodexHome, "skills"), enabled: true }];
  }
  return [{ path: "~/.codex/skills", enabled: true }];
}

export function createDefaultSkillsSettings(): SkillsSettings {
  return {
    version: 1,
    enabled: true,
    autoDiscoverHostSkills: true,
    includeSystemSkills: false,
    disabledSkills: [],
    skillDirectories: getDefaultSkillDirectories(),
    updatedAt: null,
  };
}
