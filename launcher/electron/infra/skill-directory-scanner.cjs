const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_SCAN_DEPTH = 3;
const MAX_SKILLS_PER_DIR = 200;
const SKILL_FILE_NAME = "SKILL.md";

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "__pycache__",
]);

const SUGGESTED_SKILL_PATHS = [
  "~/.codex/skills",
  "~/.agents/skills",
  "~/.claude/skills",
  "~/.gemini/config/skills",
];

const SOURCE_ORDER = {
  workspace: 0,
  custom: 1,
  user: 2,
  unknown: 3,
  system: 4,
};

function normalizeSlash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizePathKey(resolvedPath) {
  const cleaned = String(resolvedPath || "").replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? cleaned.toLowerCase()
    : cleaned;
}

function expandSkillPath(rawPath) {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) return "";
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(path.join(os.homedir(), trimmed.slice(2)));
  }
  return path.resolve(trimmed);
}

function unquoteYamlScalar(raw) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseSkillDocument(rawMarkdown, fallbackName) {
  const normalized = String(rawMarkdown || "").replace(/^\uFEFF/, "");
  let name = "";
  let description = "";
  let body = normalized.trim();

  const frontmatterMatch = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1] || "";
    body = normalized.slice(frontmatterMatch[0].length).trim();
    const lines = yaml.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || "";
      const fieldMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
      if (!fieldMatch) continue;

      const key = fieldMatch[1].toLowerCase();
      const rawVal = (fieldMatch[2] || "").trim();
      if (key !== "name" && key !== "description") continue;

      let value = "";
      if (rawVal === ">" || rawVal === ">-" || rawVal === "|" || rawVal === "|-") {
        const collected = [];
        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1] || "";
          if (/^[ \t]+/.test(nextLine)) {
            collected.push(nextLine.trim());
            i++;
          } else if (nextLine.trim() === "") {
            collected.push("");
            i++;
          } else {
            break;
          }
        }
        value = rawVal.startsWith("|")
          ? collected.join("\n").trim()
          : collected.filter(Boolean).join(" ").trim();
      } else {
        value = unquoteYamlScalar(rawVal);
      }

      if (key === "name" && value) {
        name = value.slice(0, 120);
      } else if (key === "description" && value) {
        description = value.slice(0, 600);
      }
    }
  }

  if (!description && body) {
    for (const line of body.split(/\r?\n/)) {
      const cleaned = line.trim();
      if (!cleaned || cleaned.startsWith("#") || cleaned.startsWith("```")) continue;
      description = cleaned.slice(0, 300);
      break;
    }
  }

  return {
    name: name || String(fallbackName || "").trim() || "unnamed-skill",
    description,
    body: body || normalized.trim(),
  };
}

function readAllowImplicitInvocation(skillDir) {
  const policyPath = path.join(skillDir, "agents", "openai.yaml");
  if (!fs.existsSync(policyPath)) return true;
  try {
    const content = fs.readFileSync(policyPath, "utf8");
    return !/allow_implicit_invocation\s*:\s*false\b/i.test(content);
  } catch {
    return true;
  }
}

function classifyDirectorySkillSource(absolutePath, rootPath) {
  const normPath = normalizeSlash(absolutePath).toLowerCase();
  const normRoot = normalizeSlash(rootPath).toLowerCase();
  if (
    normRoot.endsWith("/.system") ||
    normRoot.includes("/.codex/skills/.system") ||
    normPath.includes("/.codex/skills/.system/") ||
    normPath.includes("/.system/")
  ) {
    return "system";
  }
  const parentDir = normalizeSlash(path.dirname(absolutePath)).toLowerCase();
  if (parentDir.includes("/.system/")) {
    return "system";
  }
  return "custom";
}

function scanSkillDirectory(entry) {
  const rawPath = entry && typeof entry.path === "string" ? entry.path : "";
  const enabled = entry ? entry.enabled !== false : true;
  const resolvedPath = expandSkillPath(rawPath);

  if (!resolvedPath) {
    return {
      summary: {
        path: rawPath,
        resolvedPath: "",
        enabled,
        exists: false,
        skillCount: 0,
        error: "Empty directory path",
      },
      skills: [],
    };
  }

  if (!fs.existsSync(resolvedPath)) {
    return {
      summary: {
        path: rawPath,
        resolvedPath,
        enabled,
        exists: false,
        skillCount: 0,
        error: "Directory not found",
      },
      skills: [],
    };
  }

  let rootStats;
  try {
    rootStats = fs.statSync(resolvedPath);
  } catch (error) {
    return {
      summary: {
        path: rawPath,
        resolvedPath,
        enabled,
        exists: false,
        skillCount: 0,
        error: error instanceof Error ? error.message : String(error),
      },
      skills: [],
    };
  }

  if (!rootStats.isDirectory()) {
    return {
      summary: {
        path: rawPath,
        resolvedPath,
        enabled,
        exists: false,
        skillCount: 0,
        error: "Path is not a directory",
      },
      skills: [],
    };
  }

  const now = new Date().toISOString();
  const skills = [];
  const visitedRealDirs = new Set();
  const seenFiles = new Set();

  const walk = (currentDir, depth) => {
    if (skills.length >= MAX_SKILLS_PER_DIR) return;

    let realDir = currentDir;
    try {
      realDir = fs.realpathSync(currentDir);
    } catch {
      return;
    }
    if (visitedRealDirs.has(realDir)) return;
    visitedRealDirs.add(realDir);

    const directSkillPath = path.join(currentDir, SKILL_FILE_NAME);
    if (fs.existsSync(directSkillPath)) {
      try {
        const st = fs.statSync(directSkillPath);
        if (st.isFile()) {
          const realSkillPath = fs.realpathSync(directSkillPath);
          if (!seenFiles.has(realSkillPath)) {
            seenFiles.add(realSkillPath);
            const raw = fs.readFileSync(directSkillPath, "utf8");
            const parsed = parseSkillDocument(raw, path.basename(currentDir));
            const source = classifyDirectorySkillSource(directSkillPath, resolvedPath);
            const allowImplicitInvocation = readAllowImplicitInvocation(currentDir);

            skills.push({
              name: parsed.name,
              description: parsed.description,
              absolutePath: directSkillPath,
              source,
              lastSeenAt: now,
              directoryPath: rawPath,
              allowImplicitInvocation,
            });
          }
          if (depth > 0) return;
        }
      } catch {
        // Ignore unreadable file
      }
    }

    if (depth >= MAX_SCAN_DEPTH) return;

    let dirEntries;
    try {
      dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirEntries) {
      if (skills.length >= MAX_SKILLS_PER_DIR) break;
      const childName = dirent.name;
      if (IGNORED_DIR_NAMES.has(childName)) continue;
      if (childName.startsWith(".") && childName !== ".system") continue;

      const childPath = path.join(currentDir, childName);
      let isDir = dirent.isDirectory();
      if (!isDir && dirent.isSymbolicLink()) {
        try {
          isDir = fs.statSync(childPath).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) {
        walk(childPath, depth + 1);
      }
    }
  };

  walk(resolvedPath, 0);

  return {
    summary: {
      path: rawPath,
      resolvedPath,
      enabled,
      exists: true,
      skillCount: skills.length,
      error: null,
    },
    skills,
  };
}

function scanSkillDirectories(entries) {
  const directories = [];
  const skills = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const result = scanSkillDirectory(entry);
    directories.push(result.summary);
    if (entry.enabled !== false) {
      skills.push(...result.skills);
    }
  }

  return { directories, skills };
}

function detectSuggestedSkillDirectories(configuredEntries) {
  const configuredKeys = new Set(
    (Array.isArray(configuredEntries) ? configuredEntries : [])
      .map((entry) => normalizePathKey(expandSkillPath(entry.path)))
      .filter(Boolean),
  );

  const suggestions = [];
  for (const candidatePath of SUGGESTED_SKILL_PATHS) {
    const resolvedPath = expandSkillPath(candidatePath);
    const key = normalizePathKey(resolvedPath);
    if (!key || configuredKeys.has(key)) continue;

    const scan = scanSkillDirectory({ path: candidatePath, enabled: true });
    if (!scan.summary.exists) continue;

    suggestions.push({
      path: candidatePath,
      resolvedPath,
      skillCount: scan.summary.skillCount,
    });
  }

  return suggestions;
}

function mergeDiscoveredAndDirectorySkills(hostSkills, directorySkills) {
  const combined = [
    ...(Array.isArray(hostSkills) ? hostSkills : []),
    ...(Array.isArray(directorySkills) ? directorySkills : []),
  ];

  const sorted = [...combined].sort((a, b) => {
    const rankA = SOURCE_ORDER[a.source] ?? SOURCE_ORDER.unknown;
    const rankB = SOURCE_ORDER[b.source] ?? SOURCE_ORDER.unknown;
    return rankA - rankB;
  });

  const seenExact = new Set();
  const winnerByName = new Map();
  const merged = [];

  for (const skill of sorted) {
    const nameKey = String(skill.name || "").trim().toLowerCase();
    const pathKey = normalizePathKey(expandSkillPath(skill.absolutePath));
    if (!nameKey || !pathKey) continue;

    const exactKey = `${nameKey}::${pathKey}`;
    if (seenExact.has(exactKey)) continue;
    seenExact.add(exactKey);

    const existingWinner = winnerByName.get(nameKey);
    if (!existingWinner) {
      winnerByName.set(nameKey, skill);
      merged.push({
        ...skill,
        allowImplicitInvocation: skill.allowImplicitInvocation !== false,
        overriddenBy: null,
      });
    } else {
      merged.push({
        ...skill,
        allowImplicitInvocation: skill.allowImplicitInvocation !== false,
        overriddenBy: existingWinner.source,
      });
    }
  }

  return merged;
}

module.exports = {
  SUGGESTED_SKILL_PATHS,
  detectSuggestedSkillDirectories,
  expandSkillPath,
  mergeDiscoveredAndDirectorySkills,
  normalizePathKey,
  parseSkillDocument,
  scanSkillDirectories,
  scanSkillDirectory,
};
