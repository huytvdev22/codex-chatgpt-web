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

test("skills-store đọc/ghi an toàn và chuẩn hóa disabledSkills", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-skills-"));
  try {
    const settingsPath = path.join(dir, "skills.json");
    const discoveredPath = path.join(dir, "discovered-skills.json");
    const store = createSkillsStore(settingsPath, discoveredPath);

    const initial = store.read();
    assert.deepEqual(initial.settings.enabled, DEFAULT_SKILLS_SETTINGS.enabled);
    assert.equal(initial.settings.includeSystemSkills, false);
    assert.deepEqual(initial.discoveredSkills, []);

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
    });

    assert.equal(saved.settings.autoDiscoverHostSkills, false);
    assert.equal(saved.settings.includeSystemSkills, true);
    assert.deepEqual(saved.settings.disabledSkills, ["ImageGen"]);
    assert.ok(saved.settings.updatedAt);
    assert.equal(saved.discoveredSkills.length, 1);
    assert.equal(saved.discoveredSkills[0].name, "e2e-codex-cli-test");

    assert.equal(readSkillsSettings(settingsPath).includeSystemSkills, true);
    assert.equal(readDiscoveredSkills(discoveredPath).length, 1);
    assert.equal(sanitizeSkillsSettings(null).enabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Launcher nối đầy đủ tab Skills và IPC launcher:skills-get / launcher:skills-save", () => {
  assert.match(electronMain, /createSkillsStore/);
  assert.match(ipcRouterSource, /handle\("launcher:skills-get"/);
  assert.match(ipcRouterSource, /handle\("launcher:skills-save"/);
  assert.match(preloadSource, /getSkills:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("launcher:skills-get"\)/);
  assert.match(preloadSource, /saveSkills:\s*\(settings\)\s*=>\s*ipcRenderer\.invoke\("launcher:skills-save",\s*settings\)/);
  assert.match(appSource, /<SkillsSurface/);
  assert.match(appSource, /navigateSurface\("skills"\)/);
});
