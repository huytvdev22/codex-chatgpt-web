const languages = require("../languages.json");
const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 420;
const SESSION_REFRESH_REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000;
const DEFAULT_PROVIDER_PROFILE_ID = "default";
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const DEFAULT_STATE = Object.freeze({
  version: 1,
  language: null,
  onboardingComplete: false,
  githubOpened: false,
  xOpened: false,
  autoStart: true,
  keepRunningOnClose: true,
  showBrowserDuringTurns: true,
  experimentalBiggerContext: false,
  experimentalSkillAttachments: false,
  experimentalFreshConversationPerTurn: false,
  useSavedChats: false,
  browserSmokePassed: false,
  browserSmokeVersion: null,
  smokePassedByProvider: {},
  sidebarOpen: true,
  sidebarWidth: 252,
  sessionRefreshReminderAt: null,
  selectedProvider: "m365",
});

function cloneDefaultProviderProfiles() {
  return {
    "ai-studio": {
      activeProfileId: DEFAULT_PROVIDER_PROFILE_ID,
      profiles: [{ id: DEFAULT_PROVIDER_PROFILE_ID, name: "Default", authenticated: false }],
    },
  };
}

function sanitizeProviderProfiles(rawValue) {
  const result = cloneDefaultProviderProfiles();
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return result;

  for (const [providerId, group] of Object.entries(rawValue)) {
    if (!providerId || !/^[a-z0-9-]+$/.test(providerId)) continue;
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;

    const seen = new Set();
    const sanitizedList = [];
    const rawProfiles = Array.isArray(group.profiles) ? group.profiles : [];
    for (const item of rawProfiles) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const id = typeof item.id === "string" ? item.id.trim().toLowerCase() : "";
      if (!id || !PROFILE_ID_PATTERN.test(id) || seen.has(id)) continue;
      seen.add(id);
      const rawName = typeof item.name === "string" ? item.name.trim() : "";
      const name = rawName ? rawName.slice(0, 40) : (id === DEFAULT_PROVIDER_PROFILE_ID ? "Default" : id);
      sanitizedList.push({
        id,
        name,
        authenticated: item.authenticated === true,
      });
    }

    if (!seen.has(DEFAULT_PROVIDER_PROFILE_ID)) {
      sanitizedList.unshift({ id: DEFAULT_PROVIDER_PROFILE_ID, name: "Default", authenticated: false });
    }

    const requestedActive = typeof group.activeProfileId === "string"
      ? group.activeProfileId.trim().toLowerCase()
      : DEFAULT_PROVIDER_PROFILE_ID;
    const activeProfileId = sanitizedList.some(entry => entry.id === requestedActive)
      ? requestedActive
      : DEFAULT_PROVIDER_PROFILE_ID;

    result[providerId] = {
      activeProfileId,
      profiles: sanitizedList,
    };
  }
  return result;
}

function sanitizeSmokePassedByProvider(rawValue) {
  const result = {};
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return result;
  for (const [providerId, entry] of Object.entries(rawValue)) {
    if (!providerId || !/^[a-z0-9-]+$/.test(providerId)) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const passed = entry.passed === true;
    const version = typeof entry.version === "string" && entry.version.length <= 128
      ? entry.version
      : null;
    result[providerId] = { passed, version };
  }
  return result;
}

function nextSessionRefreshReminderAt(now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Session refresh reminder time must be finite");
  return new Date(now + SESSION_REFRESH_REMINDER_INTERVAL_MS).toISOString();
}

function readState(filePath, { defaultProvider = DEFAULT_STATE.selectedProvider, isValidProvider = null } = {}) {
  const defaults = {
    ...DEFAULT_STATE,
    selectedProvider: defaultProvider,
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== 1) return { ...defaults };
    const state = { ...defaults, ...parsed };
    delete state.bridgeEnabled;
    if (state.language !== null && (typeof state.language !== "string" || !Object.hasOwn(languages, state.language))) {
      state.language = DEFAULT_STATE.language;
    }
    const providerId = typeof state.selectedProvider === "string" ? state.selectedProvider.trim() : "";
    if (!providerId || (typeof isValidProvider === "function" && !isValidProvider(providerId))) {
      state.selectedProvider = defaultProvider;
    } else {
      state.selectedProvider = providerId;
    }
    state.smokePassedByProvider = sanitizeSmokePassedByProvider(parsed.smokePassedByProvider);
    if (parsed.providerProfiles !== undefined) {
      state.providerProfiles = sanitizeProviderProfiles(parsed.providerProfiles);
    } else {
      delete state.providerProfiles;
    }
    for (const key of [
      "onboardingComplete",
      "githubOpened",
      "xOpened",
      "autoStart",
      "keepRunningOnClose",
      "showBrowserDuringTurns",
      "experimentalBiggerContext",
      "experimentalSkillAttachments",
      "experimentalFreshConversationPerTurn",
      "useSavedChats",
      "browserSmokePassed",
      "sidebarOpen",
    ]) {
      if (typeof state[key] !== "boolean") state[key] = DEFAULT_STATE[key];
    }
    delete state.browserInteractionMode;
    if (state.browserSmokeVersion !== null
      && (typeof state.browserSmokeVersion !== "string" || state.browserSmokeVersion.length > 128)) {
      state.browserSmokeVersion = DEFAULT_STATE.browserSmokeVersion;
    }
    if (!Number.isFinite(state.sidebarWidth)
      || state.sidebarWidth < SIDEBAR_MIN_WIDTH
      || state.sidebarWidth > SIDEBAR_MAX_WIDTH) {
      state.sidebarWidth = DEFAULT_STATE.sidebarWidth;
    }
    if (state.sessionRefreshReminderAt !== null
      && (typeof state.sessionRefreshReminderAt !== "string"
        || !Number.isFinite(Date.parse(state.sessionRefreshReminderAt)))) {
      state.sessionRefreshReminderAt = DEFAULT_STATE.sessionRefreshReminderAt;
    }
    delete state.mcpGuideStep;
    delete state.mcpSetupComplete;
    delete state.mcpRuntimeInstalled;
    delete state.zeroRiskProEnabled;
    for (const key of [
      "coreSetupComplete",
      "codexCatalogVerified",
      "codexRestartRequired",
    ]) {
      if (state[key] !== undefined && typeof state[key] !== "boolean") delete state[key];
    }
    if (!parsed.smokePassedByProvider && state.browserSmokePassed === true) {
      state.smokePassedByProvider[state.selectedProvider || defaultProvider] = {
        passed: true,
        version: state.browserSmokeVersion || null,
      };
    }
    return state;
  } catch {
    return { ...defaults };
  }
}

function writeState(filePath, state) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function validateSidebarState(value) {
  if (!value || typeof value !== "object" || typeof value.open !== "boolean") {
    throw new Error("Sidebar state is invalid");
  }
  if (!Number.isFinite(value.width) || value.width < SIDEBAR_MIN_WIDTH || value.width > SIDEBAR_MAX_WIDTH) {
    throw new Error(`Sidebar width must be between ${SIDEBAR_MIN_WIDTH} and ${SIDEBAR_MAX_WIDTH}`);
  }
  return { sidebarOpen: value.open, sidebarWidth: Math.round(value.width) };
}

function createStateStore(filePath, options = {}) {
  let state = readState(filePath, options);
  return {
    read() {
      return structuredClone(state);
    },
    update(patch) {
      const next = { ...state, ...patch, version: 1 };
      if (patch && Object.hasOwn(patch, "providerProfiles")) {
        next.providerProfiles = sanitizeProviderProfiles(patch.providerProfiles);
      }
      writeState(filePath, next);
      state = next;
      return structuredClone(next);
    },
  };
}

module.exports = {
  DEFAULT_PROVIDER_PROFILE_ID,
  PROFILE_ID_PATTERN,
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  createStateStore,
  nextSessionRefreshReminderAt,
  sanitizeProviderProfiles,
  validateSidebarState,
};

