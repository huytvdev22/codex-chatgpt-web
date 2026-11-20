const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_SKILLS_SETTINGS,
  createSkillsStore,
  readDiscoveredSkills,
  readSkillsSettings,
  sanitizeSkillsSettings,
} = require("../electron/infra/skills-store.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const ipcRouterSource = fs.readFileSync(path.join(launcherRoot, "electron", "app", "ipc-router.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");

test("skills-store đọc/ghi an toàn, mặc định có ~/.codex/skills và tôn trọng khi user xóa hết thư mục", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-skills-"));
  try {
    const settingsPath = path.join(dir, "skills.json");
    const discoveredPath = path.join(dir, "discovered-skills.json");
    const customSkillsDir = path.join(dir, "my-skills");
    const customSkillA = path.join(customSkillsDir, "alpha-skill");
    const customSkillDup = path.join(customSkillsDir, "e2e-codex-cli-test");
    fs.mkdirSync(customSkillA, { recursive: true });
    fs.mkdirSync(customSkillDup, { recursive: true });
    fs.writeFileSync(
      path.join(customSkillA, "SKILL.md"),
      "---\nname: alpha-skill\ndescription: Custom alpha skill\n---\nAlpha body",
    );
    fs.writeFileSync(
      path.join(customSkillDup, "SKILL.md"),
      "---\nname: e2e-codex-cli-test\ndescription: Duplicate custom skill\n---\nDup body",
    );

    const store = createSkillsStore(settingsPath, discoveredPath);

    const initial = store.read();
    assert.deepEqual(initial.settings.enabled, DEFAULT_SKILLS_SETTINGS.enabled);
    assert.equal(initial.settings.includeSystemSkills, false);
    assert.ok(initial.settings.skillDirectories.length >= 1);

    fs.writeFileSync(
      discoveredPath,
      JSON.stringify({
        version: 1,
        skills: [
          {
            name: "e2e-codex-cli-test",
            description: "Runbook test",
            absolutePath: "/repo/.agents/skills/e2e-codex-cli-test/SKILL.md",
            source: "workspace",
            lastSeenAt: "2026-11-20T03:00:00.000Z",
          },
          {
            name: "",
            absolutePath: "/invalid",
          },
        ],
      }),
    );

    const saved = store.save({
      enabled: true,
      autoDiscoverHostSkills: false,
      includeSystemSkills: true,
      disabledSkills: ["  ImageGen  ", "imagegen", ""],
      skillDirectories: [
        { path: customSkillsDir, enabled: true },
        { path: customSkillsDir, enabled: false }, // duplicate path must be deduped
      ],
    });

    assert.equal(saved.settings.autoDiscoverHostSkills, false);
    assert.equal(saved.settings.includeSystemSkills, true);
    assert.deepEqual(saved.settings.disabledSkills, ["ImageGen"]);
    assert.equal(saved.settings.skillDirectories.length, 1);
    assert.equal(saved.directories.length, 1);
    assert.equal(saved.directories[0].exists, true);
    assert.equal(saved.directories[0].skillCount, 2);
    assert.ok(saved.settings.updatedAt);

    // Hợp nhất workspace + custom, đánh dấu bản custom trùng tên bị workspace override
    const alpha = saved.discoveredSkills.find((item) => item.name === "alpha-skill");
    assert.ok(alpha);
    assert.equal(alpha.source, "custom");
    assert.equal(alpha.overriddenBy, null);

    const e2eWorkspace = saved.discoveredSkills.find(
      (item) => item.name === "e2e-codex-cli-test" && item.source === "workspace",
    );
    const e2eCustom = saved.discoveredSkills.find(
      (item) => item.name === "e2e-codex-cli-test" && item.source === "custom",
    );
    assert.ok(e2eWorkspace);
    assert.equal(e2eWorkspace.overriddenBy, null);
    assert.ok(e2eCustom);
    assert.equal(e2eCustom.overriddenBy, "workspace");

    // Kiểm tra allowlist cho open-directory
    assert.equal(store.resolveAllowedDirectory(customSkillsDir), customSkillsDir);
    assert.equal(store.resolveAllowedDirectory("/etc"), null);

    // Xóa hết skillDirectories phải giữ nguyên []
    const cleared = store.save({
      ...saved.settings,
      skillDirectories: [],
    });
    assert.deepEqual(cleared.settings.skillDirectories, []);
    assert.equal(readSkillsSettings(settingsPath).skillDirectories.length, 0);
    assert.equal(readDiscoveredSkills(discoveredPath).length, 1);
    assert.equal(sanitizeSkillsSettings(null).enabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Launcher nối đầy đủ tab Skills và IPC skills-get/save/pick-directory/open-directory", () => {
  assert.match(electronMain, /createSkillsStore/);
  assert.match(ipcRouterSource, /handle\("launcher:skills-get"/);
  assert.match(ipcRouterSource, /handle\("launcher:skills-save"/);
  assert.match(ipcRouterSource, /handle\("launcher:skills-pick-directory"/);
  assert.match(ipcRouterSource, /handle\("launcher:skills-open-directory"/);
  assert.match(preloadSource, /getSkills:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("launcher:skills-get"\)/);
  assert.match(preloadSource, /saveSkills:\s*\(settings\)\s*=>\s*ipcRenderer\.invoke\("launcher:skills-save",\s*settings\)/);
  assert.match(preloadSource, /pickSkillDirectory:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("launcher:skills-pick-directory"\)/);
  assert.match(preloadSource, /openSkillDirectory:\s*\(targetPath\)\s*=>\s*ipcRenderer\.invoke\("launcher:skills-open-directory",\s*targetPath\)/);
  assert.match(appSource, /<SkillsSurface/);
  assert.match(appSource, /navigateSurface\("skills"\)/);
});
