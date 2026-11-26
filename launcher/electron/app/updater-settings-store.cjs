const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("../infra/atomic-file.cjs");

const DEFAULT_UPDATER_SETTINGS = Object.freeze({
  version: 1,
  autoCheckOnStartup: true,
  ignoredVersion: null,
  lastCheckedAt: null,
});

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Lưu cấu hình Auto-Updater cục bộ tại userData (tối giản: tự kiểm tra khi mở app & bỏ qua phiên bản).
 */
class UpdaterSettingsStore {
  constructor(userDataPath) {
    if (!userDataPath || typeof userDataPath !== "string") {
      throw new Error("UpdaterSettingsStore requires userDataPath");
    }
    this.settingsPath = path.join(userDataPath, "updater-settings.json");
    this.settings = this.load();
  }

  normalize(raw = {}, existing = DEFAULT_UPDATER_SETTINGS) {
    const ignoredVersion = raw.ignoredVersion === null
      ? null
      : typeof raw.ignoredVersion === "string"
        ? raw.ignoredVersion.trim() || null
        : existing.ignoredVersion;

    const lastCheckedAt = raw.lastCheckedAt === null
      ? null
      : typeof raw.lastCheckedAt === "string" && Number.isFinite(Date.parse(raw.lastCheckedAt))
        ? raw.lastCheckedAt
        : existing.lastCheckedAt;

    return {
      version: 1,
      autoCheckOnStartup: typeof raw.autoCheckOnStartup === "boolean"
        ? raw.autoCheckOnStartup
        : Boolean(existing.autoCheckOnStartup),
      ignoredVersion,
      lastCheckedAt,
    };
  }

  load() {
    const persisted = readJsonSafe(this.settingsPath);
    if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) {
      return { ...DEFAULT_UPDATER_SETTINGS };
    }
    return this.normalize(persisted, DEFAULT_UPDATER_SETTINGS);
  }

  persist(nextSettings) {
    writePrivateFileAtomic(this.settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
  }

  getSettings() {
    return { ...this.settings };
  }

  saveSettings(patch = {}) {
    this.settings = this.normalize(patch, this.settings);
    this.persist(this.settings);
    return this.getSettings();
  }
}

module.exports = {
  DEFAULT_UPDATER_SETTINGS,
  UpdaterSettingsStore,
};
