const { BrowserWindow, dialog, ipcMain, shell } = require("electron");
const languages = require("../languages.json");
const { releaseRetainedConversation } = require("../browser/retained-turn-release.cjs");
const { registerLoggedIpc } = require("../infra/logging.cjs");
const { validateSidebarState } = require("../infra/state-store.cjs");
const { setAutostart } = require("./autostart.cjs");
const { nativeCopyFor } = require("./tray-controller.cjs");

function validateLanguage(value) {
  if (typeof value !== "string" || !Object.hasOwn(languages, value)) {
    throw new Error(`Language must be one of: ${Object.keys(languages).join(", ")}`);
  }
  return value;
}

function validateBounds(value) {
  if (!value || typeof value !== "object") throw new Error("Browser bounds are required");
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(value[key])) throw new Error(`Browser bounds ${key} must be finite`);
  }
  return value;
}

function smokePassedForCurrentVersion(_state) {
  return true;
}

function windowStateSnapshot(window) {
  return {
    fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
  };
}

function syncFreshConversationPreference(stateStore, config, { runtimeHost, browserHost, send } = {}) {
  const useSavedChats = config?.useSavedChats === true;
  const enabled = config?.experimentalFreshConversationPerTurn === true;
  const current = stateStore.read();
  if (!runtimeHost || !browserHost || runtimeHost?.currentOperation()) return current;
  if (current.experimentalFreshConversationPerTurn === enabled && current.useSavedChats === useSavedChats) return current;
  // Runtime restarts leave browser views alive. Retire completed chats when their
  // persistence policy changes, including changes made by the CLI.
  const retainedKeys = new Set([...browserHost.turnTabs.values()]
    .filter(tab => tab.status === "ready" && tab.conversationKey)
    .map(tab => tab.conversationKey));
  for (const key of retainedKeys) releaseRetainedConversation(browserHost, key);
  const state = stateStore.update({ experimentalFreshConversationPerTurn: enabled, useSavedChats });
  send?.("launcher:state-changed", state);
  return state;
}

class IpcRouter {
  constructor(deps) {
    this.deps = deps;
  }

  register() {
    const {
      app,
      logger,
      stateStore,
      personalizationStore,
      skillsStore,
      usageStore,
      modelsStore,
      limitsStore,
      launcherProfile,
      isDevProfile,
      coreHome,
      launcherUserData,
      githubUrl,
      xUrl,
      allowedExternalUrls,
      awaitRuntimeStartup,
      getMainWindow,
      getBrowserHost,
      getRuntimeHost,
      getUpdateController,
      getLastOperation,
      isSmokePassedThisSession,
      markSmokePassedThisSession,
      send,
      openWebUrl,
      updateTrayMenu,
      startCatalogVerificationMonitor,
      stopCatalogVerificationMonitor,
      requestQuit,
    } = this.deps;

    const runtimeChannels = new Set([
      "launcher:setup-core", "launcher:uninstall-integration",
      "launcher:bigger-context", "launcher:skill-attachments", "launcher:fresh-conversation-per-turn",
      "launcher:use-saved-chats",
      "launcher:connector-name", "launcher:doctor", "launcher:open-swagger", "launcher:cancel-turns",
      "launcher:browser-smoke", "launcher:models-refresh", "launcher:limits-refresh",
      "launcher:update-install", "launcher:complete-onboarding",
    ]);
    const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, async (...args) => {
      if (runtimeChannels.has(channel)) await awaitRuntimeStartup();
      return handler(...args);
    });
    const syncPrefs = (config) => syncFreshConversationPreference(stateStore, config, {
      runtimeHost: getRuntimeHost(),
      browserHost: getBrowserHost(),
      send,
    });

    handle("launcher:snapshot", async () => {
      const runtimeHost = getRuntimeHost();
      const browserHost = getBrowserHost();
      const updateController = getUpdateController();
      const state = syncPrefs(runtimeHost?.runtimeConfigSnapshot().config);
      const browser = browserHost?.snapshot() ?? null;
      const providers = browser?.providers ?? browserHost?.listProviders?.() ?? [];
      return {
        profile: launcherProfile.kind,
        profilePaths: {
          coreHome,
          codexHome: launcherProfile.codexHome,
          userData: launcherUserData,
        },
        state,
        browser,
        providers,
        connectorName: runtimeHost ? runtimeHost.browserConnectorName() : "Codex Native2",
        urls: { github: githubUrl, x: xUrl },
        platform: process.platform,
        packaged: app.isPackaged,
        version: app.getVersion(),
        smokePassed: isSmokePassedThisSession() || smokePassedForCurrentVersion(state),
        smokePassedByProvider: state.smokePassedByProvider || {},
        operation: getLastOperation(),
        update: updateController?.getState() ?? { status: "disabled" },
        updaterSettings: updateController?.getSettings?.() ?? null,
      };
    });

    handle("launcher:set-language", (_event, language) => {
      const state = stateStore.update({ language: validateLanguage(language) });
      updateTrayMenu(state.language);
      return state;
    });
    handle("launcher:open-social", async (_event, target) => {
      const url = target === "github" ? githubUrl : target === "x" ? xUrl : null;
      if (!url) throw new Error("Unknown social target");
      await openWebUrl(url);
      const patch = target === "github" ? { githubOpened: true } : { xOpened: true };
      return stateStore.update(patch);
    });
    handle("launcher:complete-onboarding", (_event, language) => {
      const current = stateStore.read();
      if (current.autoStart) setAutostart(app, true);
      const next = stateStore.update({
        language: validateLanguage(language),
        onboardingComplete: true,
      });
      updateTrayMenu(next.language);
      logger.info("launcher.onboarding_completed", {
        language: next.language,
      });
      return next;
    });

    handle("launcher:open-external", async (_event, url) => {
      if (!allowedExternalUrls.has(url)) throw new Error("External URL is not allowlisted");
      await openWebUrl(url);
      return true;
    });

    handle("launcher:browser-bounds", (event, bounds) => {
      getBrowserHost()?.setBounds(validateBounds(bounds), event.sender.getZoomFactor());
      return true;
    });
    handle("launcher:browser-surface-active", (_event, active) => {
      const browserHost = getBrowserHost();
      return browserHost ? browserHost.setSurfaceActive(active === true) : false;
    });
    handle("launcher:browser-show", () => getBrowserHost()?.reveal(true) ?? null);
    handle("launcher:browser-hide", () => {
      const browserHost = getBrowserHost();
      browserHost?.hide();
      return browserHost?.snapshot() ?? null;
    });
    handle("launcher:browser-navigate", (_event, action) => getBrowserHost()?.navigate(action) ?? null);
    handle("launcher:browser-devtools", () => {
      const browserHost = getBrowserHost();
      return browserHost ? browserHost.openDevTools() : false;
    });
    handle("launcher:browser-zoom", (_event, action) => getBrowserHost()?.zoom(action) ?? null);
    handle("launcher:browser-tab-select", (_event, tabId) => getBrowserHost()?.selectTab(tabId) ?? null);
    handle("launcher:browser-tab-close", (_event, tabId) => getBrowserHost()?.closeTab(tabId) ?? null);
    handle("launcher:list-providers", async () => {
      const browserHost = getBrowserHost();
      if (!browserHost) return [];
      await browserHost.syncProfilesAuthFromSessions?.().catch(() => {});
      return browserHost.listProviders?.() ?? [];
    });
    handle("launcher:switch-provider", async (_event, providerId) => {
      if (!getBrowserHost()) await awaitRuntimeStartup();
      const browserHost = getBrowserHost();
      const nextSnapshot = await browserHost.switchProvider(providerId);
      if (nextSnapshot?.provider) {
        const updated = stateStore.update({ selectedProvider: nextSnapshot.provider });
        send("launcher:state-changed", updated);
      }
      return nextSnapshot;
    });
    handle("launcher:switch-provider-profile", async (_event, providerId, profileId) => {
      if (!getBrowserHost()) await awaitRuntimeStartup();
      return await getBrowserHost().switchProviderProfile(providerId, profileId);
    });
    handle("launcher:create-provider-profile", async (_event, providerId, name) => {
      if (!getBrowserHost()) await awaitRuntimeStartup();
      return getBrowserHost().createProviderProfile(providerId, name);
    });
    handle("launcher:rename-provider-profile", async (_event, providerId, profileId, name) => {
      if (!getBrowserHost()) await awaitRuntimeStartup();
      return getBrowserHost().renameProviderProfile(providerId, profileId, name);
    });
    handle("launcher:delete-provider-profile", async (_event, providerId, profileId) => {
      if (!getBrowserHost()) await awaitRuntimeStartup();
      return await getBrowserHost().deleteProviderProfile(providerId, profileId);
    });
    handle("launcher:browser-login", async (_event, providerId, profileId = null) => {
      if (!getBrowserHost()) await awaitRuntimeStartup();
      return await getBrowserHost().openLogin(providerId, profileId);
    });
    handle("launcher:browser-external-login-start", async (_event, providerId, profileId = null) => {
      if (!getBrowserHost()) await awaitRuntimeStartup();
      return await getBrowserHost().startExternalLogin(providerId, profileId);
    });
    handle("launcher:browser-external-login-complete", async () => {
      if (!getBrowserHost()) await awaitRuntimeStartup();
      return await getBrowserHost().completeExternalLogin();
    });
    handle("launcher:browser-external-login-cancel", async () => {
      if (!getBrowserHost()) await awaitRuntimeStartup();
      return await getBrowserHost().cancelExternalLogin();
    });
    handle("launcher:browser-smoke", async (_event, providerId, profileId = null) => {
      const browserHost = getBrowserHost();
      const result = await browserHost.smokeTest(providerId, profileId);
      const targetProvider = providerId || browserHost.provider || stateStore.read().selectedProvider || "m365";
      const current = stateStore.read();
      const updatedState = stateStore.update({
        smokePassedByProvider: {
          ...(current.smokePassedByProvider || {}),
          [targetProvider]: { passed: true, version: app.getVersion() },
        },
        browserSmokePassed: true,
        browserSmokeVersion: app.getVersion(),
      });
      send("launcher:state-changed", updatedState);
      markSmokePassedThisSession();
      return result;
    });

    handle("launcher:doctor", () => isDevProfile ? getRuntimeHost().devDoctor() : getRuntimeHost().doctor());
    handle("launcher:open-swagger", async () => {
      if (isDevProfile) throw new Error("Swagger UI shortcut is unavailable in the isolated DEV profile");
      const runtime = getRuntimeHost().runtimeConfigSnapshot();
      if (!runtime.configured || !runtime.config) {
        throw new Error("Set up the launcher before opening Swagger UI");
      }
      const { host, port } = runtime.config;
      if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("Runtime configuration has an invalid loopback endpoint");
      }
      const baseUrl = `http://${host}:${port}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      try {
        const response = await fetch(`${baseUrl}/healthz`, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Local API server is not reachable on ${baseUrl} (${detail})`);
      } finally {
        clearTimeout(timer);
      }
      const swaggerUrl = `${baseUrl}/swagger`;
      await openWebUrl(swaggerUrl);
      return { url: swaggerUrl };
    });
    handle("launcher:cancel-turns", () => {
      if (isDevProfile) throw new Error("DEV chat turns are owned by the repository CLI process");
      return getRuntimeHost().cancelActiveTurns();
    });
    handle("launcher:uninstall-integration", async () => {
      if (isDevProfile) throw new Error("DEV profile has no Codex integration to remove");
      const copy = nativeCopyFor(stateStore.read().language);
      const confirmation = await dialog.showMessageBox(getMainWindow(), {
        type: "warning",
        buttons: [copy.cancel, copy.remove],
        defaultId: 0,
        cancelId: 0,
        title: copy.removeTitle,
        message: copy.removeMessage,
        detail: copy.removeDetail,
        noLink: true,
      });
      if (confirmation.response !== 1) return { cancelled: true };
      const runtimeHost = getRuntimeHost();
      const browserHost = getBrowserHost();
      try {
        await runtimeHost.uninstallIntegration();
      } finally {
        browserHost.writeDescriptor();
      }
      const state = stateStore.update({
        coreSetupComplete: false,
        codexCatalogVerified: false,
        codexRestartRequired: true,
        experimentalBiggerContext: false,
        experimentalSkillAttachments: false,
        experimentalFreshConversationPerTurn: false,
        useSavedChats: false,
      });
      send("launcher:state-changed", state);
      stopCatalogVerificationMonitor();
      return { cancelled: false, state };
    });
    handle("launcher:setup-core", async () => {
      const browserHost = getBrowserHost();
      const runtimeHost = getRuntimeHost();
      const result = isDevProfile ? await runtimeHost.setupDevCore() : await runtimeHost.setupCore();
      stateStore.update({
        coreSetupComplete: true,
        codexCatalogVerified: isDevProfile ? true : false,
        codexRestartRequired: isDevProfile ? false : true,
        experimentalFreshConversationPerTurn: runtimeHost.runtimeConfigSnapshot().config?.experimentalFreshConversationPerTurn === true,
        useSavedChats: runtimeHost.runtimeConfigSnapshot().config?.useSavedChats === true,
      });
      await browserHost.returnToIdle().catch((error) => {
        logger.warn("browser.idle_cleanup_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      if (!isDevProfile) startCatalogVerificationMonitor();
      return { ok: true, stdout: result.stdout, restartRequired: !isDevProfile };
    });
    handle("launcher:connector-name", async (_event, suffix) => {
      const browserHost = getBrowserHost();
      const runtimeHost = getRuntimeHost();
      if (browserHost.activeTraceId || browserHost.currentOperation()) {
        throw new Error("Finish active Web turns before changing the plugin name");
      }
      const result = await runtimeHost.setConnectorNameSuffix(suffix);
      if (!result.changed) return stateStore.read();
      const state = stateStore.read();
      send("launcher:connector-name-changed", runtimeHost.browserConnectorName());
      send("launcher:state-changed", state);
      return state;
    });

    handle("launcher:autostart", (_event, enabled) => {
      if (isDevProfile) throw new Error("The isolated DEV launcher is started explicitly from the repository CLI");
      const desired = enabled === true;
      const autostart = setAutostart(app, desired);
      return {
        state: stateStore.update({ autoStart: desired }),
        ...autostart,
      };
    });
    handle("launcher:bigger-context", async (_event, enabled) => {
      const result = await getRuntimeHost().setBiggerContext(enabled === true);
      const state = stateStore.update({
        experimentalBiggerContext: result.enabled,
        codexCatalogVerified: isDevProfile ? true : false,
        codexRestartRequired: isDevProfile ? false : true,
      });
      send("launcher:state-changed", state);
      if (!isDevProfile) startCatalogVerificationMonitor();
      return state;
    });
    handle("launcher:skill-attachments", async (_event, enabled) => {
      const browserHost = getBrowserHost();
      if (browserHost.activeTraceId || browserHost.currentOperation()) {
        throw new Error("Finish or cancel active ChatGPT turns before changing Skills as files");
      }
      const result = await getRuntimeHost().setSkillAttachments(enabled === true);
      const state = stateStore.update({ experimentalSkillAttachments: result.enabled });
      send("launcher:state-changed", state);
      return state;
    });
    handle("launcher:fresh-conversation-per-turn", async (_event, enabled) => {
      const browserHost = getBrowserHost();
      const runtimeHost = getRuntimeHost();
      if (browserHost.activeTraceId || browserHost.currentOperation()) {
        throw new Error("Finish or cancel active ChatGPT turns before changing browser conversation retention");
      }
      await runtimeHost.setFreshConversationPerTurn(enabled);
      return syncPrefs(runtimeHost.runtimeConfigSnapshot().config);
    });
    handle("launcher:use-saved-chats", async (_event, enabled) => {
      const browserHost = getBrowserHost();
      const runtimeHost = getRuntimeHost();
      if (browserHost.activeTraceId || browserHost.currentOperation()) {
        throw new Error("Finish or cancel active ChatGPT turns before changing saved chats");
      }
      await runtimeHost.setUseSavedChats(enabled);
      return syncPrefs(runtimeHost.runtimeConfigSnapshot().config);
    });
    handle("launcher:set-preference", (_event, key, value) => {
      const ordinary = key === "keepRunningOnClose" || key === "showBrowserDuringTurns";
      if (!ordinary) throw new Error("Unknown preference");
      return stateStore.update({ [key]: value === true });
    });
    handle("launcher:personalization-get", () => {
      if (!personalizationStore) throw new Error("Personalization store is unavailable");
      return personalizationStore.read();
    });
    handle("launcher:personalization-save", (_event, value) => {
      if (!personalizationStore) throw new Error("Personalization store is unavailable");
      const saved = personalizationStore.save(value);
      send("launcher:personalization-changed", saved);
      return saved;
    });
    handle("launcher:skills-get", () => {
      if (!skillsStore) throw new Error("Skills store is unavailable");
      return skillsStore.read();
    });
    handle("launcher:skills-save", (_event, value) => {
      if (!skillsStore) throw new Error("Skills store is unavailable");
      const saved = skillsStore.save(value);
      send("launcher:skills-changed", saved);
      return saved;
    });
    handle("launcher:skills-pick-directory", async () => {
      const parentWindow = getMainWindow?.();
      const options = {
        properties: ["openDirectory", "createDirectory"],
      };
      const result = parentWindow && !parentWindow.isDestroyed()
        ? await dialog.showOpenDialog(parentWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
        return { cancelled: true, path: null };
      }
      return { cancelled: false, path: result.filePaths[0] };
    });
    handle("launcher:skills-open-directory", async (_event, targetPath) => {
      if (!skillsStore) throw new Error("Skills store is unavailable");
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        throw new Error("Directory path is required");
      }
      const allowedPath = skillsStore.resolveAllowedDirectory(targetPath);
      if (!allowedPath) {
        throw new Error("Directory is not in configured skill directories or does not exist");
      }
      const errorMessage = await shell.openPath(allowedPath);
      if (errorMessage) {
        throw new Error(errorMessage);
      }
      return { ok: true, path: allowedPath };
    });
    handle("launcher:usage-get", (_event, range) => {
      if (!usageStore) throw new Error("Usage store is unavailable");
      return usageStore.read(typeof range === "string" ? range : "today");
    });
    handle("launcher:usage-save-settings", (_event, value, range) => {
      if (!usageStore) throw new Error("Usage store is unavailable");
      const saved = usageStore.saveSettings(value, typeof range === "string" ? range : "today");
      send("launcher:usage-changed", saved);
      return saved;
    });
    handle("launcher:usage-clear", (_event, range) => {
      if (!usageStore) throw new Error("Usage store is unavailable");
      const cleared = usageStore.clearHistory(typeof range === "string" ? range : "today");
      send("launcher:usage-changed", cleared);
      return cleared;
    });
    handle("launcher:models-get", async () => {
      if (!modelsStore) throw new Error("Models store is unavailable");
      return await modelsStore.getSnapshot();
    });
    handle("launcher:models-update-override", async (_event, slug, patch) => {
      if (!modelsStore) throw new Error("Models store is unavailable");
      if (typeof slug !== "string" || !slug.trim()) throw new Error("Model slug is required");
      const snapshot = await modelsStore.updateOverride(slug.trim(), patch && typeof patch === "object" ? patch : {});
      send("launcher:models-changed", snapshot);
      return snapshot;
    });
    handle("launcher:models-toggle-provider", async (_event, providerId, enabled) => {
      if (!modelsStore) throw new Error("Models store is unavailable");
      if (typeof providerId !== "string" || !providerId.trim()) throw new Error("Provider id is required");
      const snapshot = await modelsStore.toggleProvider(providerId.trim(), enabled === true);
      send("launcher:models-changed", snapshot);
      return snapshot;
    });
    handle("launcher:models-reset", async (_event, slug) => {
      if (!modelsStore) throw new Error("Models store is unavailable");
      const cleanSlug = typeof slug === "string" && slug.trim() ? slug.trim() : undefined;
      const snapshot = await modelsStore.resetModels(cleanSlug);
      send("launcher:models-changed", snapshot);
      return snapshot;
    });
    handle("launcher:models-refresh", async (_event, providerId) => {
      if (!modelsStore) throw new Error("Models store is unavailable");
      const cleanProvider = typeof providerId === "string" && providerId.trim() ? providerId.trim() : undefined;
      const outcome = await modelsStore.refreshModels(cleanProvider);
      if (outcome?.snapshot) {
        send("launcher:models-changed", outcome.snapshot);
      }
      return outcome;
    });
    handle("launcher:models-open-config", async () => {
      if (!modelsStore) throw new Error("Models store is unavailable");
      const configPath = modelsStore.ensureConfigFileExists();
      const errorMessage = await shell.openPath(configPath);
      if (errorMessage) {
        throw new Error(errorMessage);
      }
      return { ok: true, path: configPath };
    });
    handle("launcher:limits-get", async () => {
      if (!limitsStore) throw new Error("Limits store is unavailable");
      return await limitsStore.getSnapshot();
    });
    handle("launcher:limits-refresh", async (_event, providerId, profileId) => {
      if (!limitsStore) throw new Error("Limits store is unavailable");
      const cleanProvider = typeof providerId === "string" && providerId.trim() ? providerId.trim() : undefined;
      const cleanProfile = typeof profileId === "string" && profileId.trim() ? profileId.trim() : undefined;
      const outcome = await limitsStore.refreshLimits({
        providerId: cleanProvider,
        profileId: cleanProfile,
      });
      if (outcome?.snapshot) {
        send("launcher:limits-changed", outcome.snapshot);
      }
      return outcome;
    });
    handle("launcher:sidebar-state", (_event, value) => stateStore.update(validateSidebarState(value)));
    handle("launcher:update-check", async (_event, options = {}) => {
      const updateController = getUpdateController();
      if (!updateController) return { status: "disabled" };
      return updateController.checkForUpdates({ manual: options?.manual !== false });
    });
    handle("launcher:update-download", async () => {
      const updateController = getUpdateController();
      if (!updateController) throw new Error("Launcher updates are unavailable");
      return updateController.downloadUpdate();
    });
    handle("launcher:update-cancel-download", () => {
      const updateController = getUpdateController();
      if (!updateController) return { cancelled: false };
      return updateController.cancelDownload();
    });
    handle("launcher:update-open-folder", () => {
      const updateController = getUpdateController();
      if (!updateController) return { opened: false, filePath: null };
      return updateController.openDownloadedFolder();
    });
    handle("launcher:update-ignore", () => {
      const updateController = getUpdateController();
      if (!updateController) return { status: "disabled" };
      return updateController.ignoreCurrentUpdate();
    });
    handle("launcher:update-get-settings", () => {
      const updateController = getUpdateController();
      return updateController?.getSettings?.() ?? null;
    });
    handle("launcher:update-save-settings", (_event, patch = {}) => {
      const updateController = getUpdateController();
      if (!updateController) throw new Error("Launcher updates are unavailable");
      return updateController.saveSettings(patch && typeof patch === "object" ? patch : {});
    });
    handle("launcher:update-install", async () => {
      const updateController = getUpdateController();
      if (!updateController) throw new Error("Launcher updates are unavailable");
      const launch = await updateController.beginInstall();
      if (launch && launch.installed === false) {
        return launch;
      }
      const result = await requestQuit();
      if (!result.ok) {
        updateController.cancelInstall(launch);
        throw new Error(result.message);
      }
      return { installed: true, version: launch?.version ?? null };
    });
    handle("launcher:window-state", (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      return windowStateSnapshot(window);
    });
    ipcMain.on("launcher:window-control", (event, action) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) return;
      if (action === "close") window.close();
      else if (action === "minimize") window.minimize();
      else if (action === "zoom") window.isMaximized() ? window.unmaximize() : window.maximize();
    });
  }
}

module.exports = {
  IpcRouter,
  smokePassedForCurrentVersion,
  syncFreshConversationPreference,
  validateBounds,
  validateLanguage,
  windowStateSnapshot,
};

