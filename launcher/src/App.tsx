import languages from "../electron/languages.json";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { copyFor, localizeRuntimeMessage, type Copy } from "./i18n";
import { Icon, type IconName } from "./icons";
import { PersonalizationSurface } from "./components/PersonalizationSurface";
import { ModelsSurface } from "./components/ModelsSurface";
import { SkillsSurface } from "./components/SkillsSurface";
import { UsageSurface } from "./components/UsageSurface";
import type {
  BrowserProviderInfo,
  BrowserState,
  DoctorReport,
  Language,
  LauncherSnapshot,
  LauncherState,
  LimitStatusKind,
  OperationState,
  ProfileLimitEntry,
  ProviderLimitsSnapshot,
  Surface,
} from "./types";

function runtimeProviderIdFor(providerId: string): string {
  return providerId === "m365" ? "m365-copilot" : providerId;
}

function limitAlertBadgeText(entry: ProfileLimitEntry | undefined): string | null {
  if (!entry) return null;
  if (entry.status === "exhausted") return "Limit reached";
  if (entry.status === "warning") return "Near limit";
  if (entry.status === "challenge") return "Verify";
  return null;
}

function limitAlertTone(status: LimitStatusKind | undefined): "warning" | "exhausted" | null {
  if (status === "exhausted" || status === "challenge") return "exhausted";
  if (status === "warning") return "warning";
  return null;
}

function resolveProviders(
  browser: BrowserState | null,
  snapshot: LauncherSnapshot,
): BrowserProviderInfo[] {
  const candidates = browser?.providers?.length
    ? browser.providers
    : snapshot.providers?.length
      ? snapshot.providers
      : [];
  if (candidates.length > 0) return candidates;
  const fallbackId = browser?.provider || snapshot.state.selectedProvider || "m365";
  return [{
    id: fallbackId,
    displayName: fallbackId === "m365" ? "M365 Copilot" : fallbackId,
    homeUrl: "",
    partition: "",
    active: true,
    authenticated: browser?.authenticated === true,
  }];
}

const api = window.codexWebLauncher;
const PANEL_TRANSITION = { duration: 0.3, ease: [0.16, 1, 0.3, 1] } as const;
const COMPACT_SIDEBAR_QUERY = "(max-width: 820px)";
export function App() {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const documentLanguage = snapshot?.state.language ?? "en";

  useEffect(() => {
    document.documentElement.lang = documentLanguage;
  }, [documentLanguage]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.snapshot().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      setBrowser(next.browser);
      setOperation(next.operation);
      if (next.operation?.status === "failed") {
        setError(next.operation.message);
      }
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribeState = api.onStateChanged((state) => {
      setSnapshot((current) => current
        ? {
            ...current,
            state,
            smokePassed: current.smokePassed
              || (state.browserSmokePassed === true && state.browserSmokeVersion === current.version),
            smokePassedByProvider: state.smokePassedByProvider ?? current.smokePassedByProvider,
          }
        : current);
    });
    const unsubscribeConnectorName = api.onConnectorNameChanged(connectorName => {
      setSnapshot(current => current ? { ...current, connectorName } : current);
    });
    const unsubscribeBrowser = api.onBrowserState(setBrowser);
    const unsubscribeOperation = api.onOperation((next) => {
      setOperation(next);
      if (next.status === "failed") setError(next.message);
    });
    const unsubscribeUpdate = api.onUpdateState((update) => {
      setSnapshot((current) => current ? { ...current, update } : current);
    });
    return () => {
      cancelled = true;
      unsubscribeState();
      unsubscribeConnectorName();
      unsubscribeBrowser();
      unsubscribeOperation();
      unsubscribeUpdate();
    };
  }, []);

  const updateState = useCallback((state: LauncherState) => {
    setSnapshot((current) => current
      ? {
          ...current,
          state,
          smokePassed: current.smokePassed
            || (state.browserSmokePassed === true && state.browserSmokeVersion === current.version),
          smokePassedByProvider: state.smokePassedByProvider ?? current.smokePassedByProvider,
        }
      : current);
  }, []);

  if (!api) return <FatalMessage message="Launcher IPC is unavailable." />;
  if (!snapshot) return <LaunchLoading />;

  const language = snapshot.state.language ?? "en";
  const copy = copyFor(language, snapshot.connectorName);
  const startupLoadingOpen = operation?.status === "running"
    && (operation.name === "launcher-startup" || operation.name === "runtime-upgrade");

  return (
    <div
      className="app-root"
      data-language={language}
      data-platform={snapshot.platform}
      data-profile={snapshot.profile}
      data-theme="dark"
    >
      <AnimatePresence mode="wait">
        {!snapshot.state.onboardingComplete ? (
          <Onboarding
            key="onboarding"
            language={language}
            setError={setError}
            snapshot={snapshot}
            updateState={updateState}
          />
        ) : (
          <LauncherShell
            browser={browser}
            copy={copy}
            key="launcher"
            language={language}
            operation={operation}
            setError={setError}
            snapshot={snapshot}
            updateState={updateState}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {startupLoadingOpen && operation ? (
          <StartupLoadingModal
            operation={operation}
            product={copy.product}
            version={snapshot.version}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {error ? <ErrorToast copy={copy} message={error} onDismiss={() => setError(null)} /> : null}
      </AnimatePresence>
    </div>
  );
}

function Onboarding({
  language,
  setError,
  snapshot,
  updateState,
}: {
  language: Language;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [selectedLanguage, setSelectedLanguage] = useState<Language>(language);
  const [busy, setBusy] = useState(false);
  const localized = copyFor(selectedLanguage);

  const chooseLanguage = async (next: Language) => {
    setSelectedLanguage(next);
    setError(null);
    try {
      updateState(await api!.setLanguage(next));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.completeOnboarding(selectedLanguage));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.main
      animate={{ opacity: 1 }}
      className="welcome"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      <header className="welcome-top draggable">
        <div className="welcome-brand no-drag">
          <BrandMark small />
          <span>{localized.product}</span>
          {snapshot.profile === "development" ? <em className="dev-profile-badge">{localized.devBadge}</em> : null}
        </div>
        <span className="welcome-version no-drag">v{snapshot.version}</span>
      </header>

      <AnimatePresence mode="wait">
        <motion.section
          animate={{ opacity: 1, y: 0 }}
          className="welcome-stage"
          exit={{ opacity: 0, y: -8 }}
          initial={{ opacity: 0, y: 8 }}
          key="language"
          transition={PANEL_TRANSITION}
        >
          <span className="welcome-kicker">01</span>
          <h1>{localized.chooseLanguage}</h1>
          <p>{localized.chooseLanguageHint}</p>

          <div className="welcome-options" role="radiogroup" aria-label={localized.chooseLanguage}>
            {languageOptions.map(option => (
              <WelcomeOption
                key={option.value}
                active={selectedLanguage === option.value}
                detail={option.label}
                label={option.label}
                marker={option.marker}
                onClick={() => void chooseLanguage(option.value)}
              />
            ))}
          </div>
        </motion.section>
      </AnimatePresence>

      <footer className="welcome-footer">
        <div />
        <div />
        <PrimaryButton
          disabled={busy}
          onClick={finish}
        >
          {localized.finishWelcome}
        </PrimaryButton>
      </footer>
    </motion.main>
  );
}

function LauncherShell({
  browser,
  copy,
  language,
  operation,
  setError,
  snapshot,
  updateState,
}: {
  browser: BrowserState | null;
  copy: Copy;
  language: Language;
  operation: OperationState | null;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const interactionSetupComplete = snapshot.state.coreSetupComplete === true
    && snapshot.state.codexCatalogVerified === true;
  const [surface, setSurface] = useState<Surface>(
    interactionSetupComplete ? "browser" : "setup",
  );
  const devProfile = snapshot.profile === "development";
  const compactAtMount = useRef(window.matchMedia(COMPACT_SIDEBAR_QUERY).matches).current;
  const [sidebarOpen, setSidebarOpen] = useState(!compactAtMount);
  const [compactSidebar, setCompactSidebar] = useState(compactAtMount);
  const [browserSlot, setBrowserSlot] = useState<HTMLDivElement | null>(null);
  const [limitsSnapshot, setLimitsSnapshot] = useState<ProviderLimitsSnapshot | null>(null);
  const browserSlotRef = useCallback((node: HTMLDivElement | null) => setBrowserSlot(node), []);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.getLimits().then((next) => {
      if (!cancelled) setLimitsSnapshot(next);
    }).catch(() => {});
    const unsubscribeLimits = api.onLimitsChanged((next) => {
      setLimitsSnapshot(next);
    });
    return () => {
      cancelled = true;
      unsubscribeLimits();
    };
  }, []);

  const limitEntryByKey = useMemo(() => {
    const map = new Map<string, ProfileLimitEntry>();
    for (const entry of limitsSnapshot?.entries ?? []) {
      map.set(`${entry.providerId}::${entry.profileId}`, entry);
    }
    return map;
  }, [limitsSnapshot]);

  const hasActiveLimitAlert = useMemo(
    () =>
      (limitsSnapshot?.entries ?? []).some(
        (entry) =>
          entry.isActive &&
          (entry.status === "warning" ||
            entry.status === "exhausted" ||
            entry.status === "challenge"),
      ),
    [limitsSnapshot],
  );

  const startupLoadingOpen = operation?.status === "running"
    && (operation.name === "launcher-startup" || operation.name === "runtime-upgrade");
  const browserSurfaceActive = surface === "browser"
    && !(compactSidebar && sidebarOpen)
    && !startupLoadingOpen;
  const providers = resolveProviders(browser, snapshot);
  const anyProviderAuthenticated = providers.some((item) => item.authenticated)
    || Object.values(browser?.authenticatedByProvider ?? {}).some(Boolean);
  const needsBrowser = browser?.authenticated !== true && !anyProviderAuthenticated;
  const needsSetup = !needsBrowser && !interactionSetupComplete;
  const updateVisible = ["available", "downloading", "installing"].includes(snapshot.update.status);
  const updateBusy = snapshot.update.status === "downloading" || snapshot.update.status === "installing";
  const updateVersion = "version" in snapshot.update ? snapshot.update.version : null;

  useLayoutEffect(() => {
    let cancelled = false;
    let animationFrame = 0;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      if (!browserSlot) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const rect = browserSlot.getBoundingClientRect();
        void api!.setBrowserBounds({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }).catch((cause) => setError(messageOf(cause)));
      });
    };

    void api!.setBrowserSurfaceActive(browserSurfaceActive).then(() => {
      if (cancelled || !browserSurfaceActive || !browserSlot) return;
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(browserSlot);
      window.addEventListener("resize", measure);
    }).catch((cause) => setError(messageOf(cause)));

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [browserSlot, browserSurfaceActive, setError]);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_SIDEBAR_QUERY);
    const apply = () => {
      setCompactSidebar(media.matches);
      setSidebarOpen(!media.matches);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  const activateBrowser = useCallback(async (show = false) => {
    setSurface("browser");
    await api!.setBrowserSurfaceActive(true);
    if (show) await api!.showBrowser();
  }, []);

  const toggleSidebar = () => {
    const next = !sidebarOpen;
    if (compactSidebar && next && surface === "browser") {
      void api!.setBrowserSurfaceActive(false)
        .then(() => setSidebarOpen(true))
        .catch((cause) => setError(messageOf(cause)));
      return;
    }
    setSidebarOpen(next);
  };

  const navigateSurface = (next: Surface) => {
    setSurface(next);
    if (compactSidebar) setSidebarOpen(false);
  };

  const installUpdate = async () => {
    setError(null);
    try {
      await api!.installUpdate();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  return (
    <motion.main
      animate={{ opacity: 1 }}
      className={`app-shell${compactSidebar ? " is-compact" : ""}${sidebarOpen ? " is-sidebar-open" : ""}`}
      initial={{ opacity: 0 }}
    >
      <TitleBar
        copy={copy}
        devProfile={devProfile}
        draggable={surface !== "browser"}
        sidebarOpen={sidebarOpen}
        toggleSidebar={toggleSidebar}
      />

      {compactSidebar && sidebarOpen ? (
        <button
          aria-label={copy.hideSidebar}
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          type="button"
        />
      ) : null}

      <motion.aside
        animate={{ width: sidebarOpen ? "var(--sidebar-width)" : 0 }}
        className="app-sidebar"
        initial={false}
        transition={{ type: "spring", duration: 0.5, bounce: 0.08 }}
      >
        <div className="sidebar-clip">
          <div className="sidebar-content">
            <div className="sidebar-brand-row">
              <div className="sidebar-brand-identity">
                <BrandMark small />
                <strong>{copy.product}</strong>
                {devProfile ? <em className="dev-profile-badge">{copy.devBadge}</em> : null}
              </div>
              <div className="sidebar-brand-actions">
                <IconButton
                  icon="github"
                  label="GitHub"
                  onClick={() => void api!.openExternal(snapshot.urls.github).catch((cause) => setError(messageOf(cause)))}
                />
                <IconButton
                  icon="x"
                  label="X"
                  onClick={() => void api!.openExternal(snapshot.urls.x).catch((cause) => setError(messageOf(cause)))}
                />
              </div>
            </div>

            <nav className="sidebar-nav" aria-label={copy.workspace}>
              <SidebarGroup label={copy.workspace}>
                <SidebarItem
                  active={surface === "browser"}
                  badge={needsBrowser ? <ActionDot pulse tone="required" /> : null}
                  icon="browser"
                  label={copy.browser}
                  onClick={async () => {
                    navigateSurface("browser");
                    await api!.setBrowserSurfaceActive(true);
                  }}
                />
              </SidebarGroup>
              <SidebarGroup label={copy.configuration}>
                <SidebarItem
                  active={surface === "setup"}
                  badge={needsSetup ? <ActionDot pulse tone="required" /> : null}
                  icon="setup"
                  label={copy.setup}
                  onClick={() => navigateSurface("setup")}
                />
                <SidebarItem
                  active={surface === "models"}
                  icon="models"
                  label={copy.models}
                  onClick={() => navigateSurface("models")}
                />
                <SidebarItem
                  active={surface === "personalization"}
                  icon="personalization"
                  label={copy.personalization}
                  onClick={() => navigateSurface("personalization")}
                />
                <SidebarItem
                  active={surface === "skills"}
                  icon="skills"
                  label={copy.skills}
                  onClick={() => navigateSurface("skills")}
                />
                <SidebarItem
                  active={surface === "usage"}
                  badge={hasActiveLimitAlert ? <ActionDot tone="required" /> : null}
                  icon="activity"
                  label={copy.usage}
                  onClick={() => navigateSurface("usage")}
                />
              </SidebarGroup>
            </nav>

            <div className="sidebar-footer">
              {updateVisible ? (
                <SidebarItem
                  active={false}
                  disabled={updateBusy || operation?.status === "running" || browser?.status === "running"}
                  icon="update"
                  label={updateBusy ? copy.updating : `${copy.updateAvailable} v${updateVersion}`}
                  onClick={() => void installUpdate()}
                  tone="update"
                />
              ) : null}
              <SidebarItem
                active={surface === "settings"}
                icon="settings"
                label={copy.settings}
                onClick={() => navigateSurface("settings")}
              />
            </div>
          </div>
        </div>
      </motion.aside>

      <section className="workspace">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            animate={{ opacity: 1 }}
            className="surface-transition"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            key={surface}
            transition={{ duration: 0.16 }}
          >
            {surface === "browser" ? (
              <BrowserSurface
                browser={browser}
                browserSlotRef={browserSlotRef}
                copy={copy}
                limitEntryByKey={limitEntryByKey}
                providers={providers}
                setError={setError}
              />
            ) : null}
            {surface === "setup" ? (
              <SetupSurface
                activateBrowser={activateBrowser}
                browser={browser}
                copy={copy}
                devProfile={devProfile}
                limitEntryByKey={limitEntryByKey}
                operation={operation}
                setError={setError}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
            {surface === "personalization" ? (
              <PersonalizationSurface
                api={api!}
                copy={copy}
                setError={setError}
              />
            ) : null}
            {surface === "models" ? (
              <ModelsSurface
                api={api!}
                browser={browser}
                copy={copy}
                providers={providers}
                setError={setError}
              />
            ) : null}
            {surface === "skills" ? (
              <SkillsSurface
                api={api!}
                copy={copy}
                setError={setError}
              />
            ) : null}
            {surface === "usage" ? (
              <UsageSurface
                api={api!}
                copy={copy}
                setError={setError}
              />
            ) : null}
            {surface === "settings" ? (
              <SettingsSurface
                copy={copy}
                devProfile={devProfile}
                language={language}
                setError={setError}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </section>
    </motion.main>
  );
}

function TitleBar({
  copy,
  devProfile,
  draggable,
  sidebarOpen,
  toggleSidebar,
}: {
  copy: Copy;
  devProfile: boolean;
  draggable: boolean;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}) {
  return (
    <header className={`app-titlebar${draggable ? " draggable" : ""}`}>
      <div className="titlebar-left no-drag">
        <IconButton
          expanded={sidebarOpen}
          icon="sidebar"
          label={sidebarOpen ? copy.hideSidebar : copy.showSidebar}
          onClick={toggleSidebar}
        />
        {devProfile ? <span className="titlebar-dev-profile">{copy.devBadge}</span> : null}
      </div>
    </header>
  );
}

function SidebarGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="sidebar-group">
      <h2>{label}</h2>
      <div>{children}</div>
    </section>
  );
}

function SidebarItem({
  active,
  badge,
  disabled = false,
  icon,
  label,
  onClick,
  tone,
}: {
  active: boolean;
  badge?: ReactNode;
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
  tone?: "update";
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`sidebar-item${active ? " is-active" : ""}${tone === "update" ? " is-update" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon === "mcp" ? <McpMark /> : <Icon name={icon} />}
      <span>{label}</span>
      {badge ? <i className="sidebar-item-badge">{badge}</i> : null}
    </button>
  );
}

function BrowserSurface({
  browser,
  browserSlotRef,
  copy,
  limitEntryByKey,
  providers,
  setError,
}: {
  browser: BrowserState | null;
  browserSlotRef: (node: HTMLDivElement | null) => void;
  copy: Copy;
  limitEntryByKey: Map<string, ProfileLimitEntry>;
  providers: BrowserProviderInfo[];
  setError: (error: string | null) => void;
}) {
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [switchingProfile, setSwitchingProfile] = useState(false);
  const [externalLoginBusy, setExternalLoginBusy] = useState(false);
  const visible = browser?.visible === true;
  const externalLogin = browser?.externalLogin ?? null;
  const externalLoginActive = Boolean(externalLogin?.active);
  const navigationLocked = browser?.status === "running" || browser?.status === "testing";
  const activeProviderId = browser?.provider || providers[0]?.id || "m365";
  const activeProvider = providers.find((item) => item.id === activeProviderId) ?? providers[0];
  const providerLabel = activeProvider?.displayName || activeProviderId;
  const supportsProfiles = activeProvider?.supportsProfiles === true;
  const profiles = activeProvider?.profiles ?? [];
  const activeProfileId = activeProvider?.activeProfileId || "default";
  const activeProfile = profiles.find((item) => item.id === activeProfileId);
  const activeTabId = browser?.activeTabId || "home";
  const profileControlLocked = switchingProvider || switchingProfile || navigationLocked || externalLoginActive;
  const showExternalChromeCard = (activeProvider?.usesExternalChromeLogin === true || activeProviderId === "ai-studio")
    && (externalLoginActive || (!browser?.authenticated && (!visible || activeTabId === "home")));
  const switchProvider = async (providerId: string) => {
    if (switchingProvider || navigationLocked || providerId === activeProviderId) return;
    setSwitchingProvider(true);
    setError(null);
    try {
      await api!.switchProvider(providerId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSwitchingProvider(false);
    }
  };
  const switchProfile = async (profileId: string) => {
    if (!supportsProfiles || profileControlLocked || profileId === activeProfileId) return;
    setSwitchingProfile(true);
    setError(null);
    try {
      await api!.switchProviderProfile(activeProviderId, profileId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSwitchingProfile(false);
    }
  };
  const createQuickProfile = async () => {
    if (!supportsProfiles || profileControlLocked) return;
    setSwitchingProfile(true);
    setError(null);
    try {
      const created = await api!.createProviderProfile(activeProviderId);
      await api!.openLogin(activeProviderId, created.profile.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSwitchingProfile(false);
    }
  };
  const startExternalChromeLogin = async (providerId = activeProviderId, profileId = activeProfileId) => {
    if (externalLoginBusy || navigationLocked || switchingProvider) return;
    setExternalLoginBusy(true);
    setError(null);
    try {
      await api!.startExternalLogin(providerId, profileId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setExternalLoginBusy(false);
    }
  };
  const completeExternalChromeLogin = async () => {
    if (externalLoginBusy) return;
    setExternalLoginBusy(true);
    setError(null);
    try {
      await api!.completeExternalLogin();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setExternalLoginBusy(false);
    }
  };
  const cancelExternalChromeLogin = async () => {
    if (externalLoginBusy) return;
    setExternalLoginBusy(true);
    setError(null);
    try {
      await api!.cancelExternalLogin();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setExternalLoginBusy(false);
    }
  };
  const navigate = async (action: "back" | "forward" | "reload") => {
    try {
      await api!.navigateBrowser(action);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const zoom = async (action: "in" | "out" | "reset") => {
    try {
      await api!.zoomBrowser(action);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const openDevTools = async () => {
    try {
      await api!.openBrowserDevTools();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const toggle = async () => {
    try {
      if (visible) await api!.hideBrowser();
      else await api!.showBrowser();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const selectTab = async (tabId: string) => {
    try {
      await api!.selectBrowserTab(tabId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const closeTab = async (tabId: string) => {
    try {
      await api!.closeBrowserTab(tabId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  return (
    <section className="browser-surface">
      <div className="browser-tab-strip" role="tablist" title={copy.browserTabLimit}>
        {(browser?.tabs ?? []).map((tab) => (
          <div
            className={`browser-tab${tab.active ? " is-active" : ""}`}
            key={tab.id}
            onClick={() => void selectTab(tab.id)}
            role="tab"
            aria-selected={tab.active}
          >
            <BrandMark small />
            <span title={tab.traceId ? `${tab.title} · ${tab.traceId}` : tab.title}>
              {browserTabTitleFromTitle(tab.title, copy)}
            </span>
            {tab.loading ? <i className="tab-spinner" /> : <StateDot state={browserTabTone(tab.status)} />}
            {tab.closable ? (
              <button
                aria-label={copy.hideTab}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab.id);
                }}
                title={copy.hideTab}
                type="button"
              >
                <Icon name="close" />
              </button>
            ) : null}
          </div>
        ))}
        <div className="browser-tab-drag draggable" />
      </div>
      <div className="browser-toolbar">
        <div className="browser-history">
          <IconButton
            disabled={navigationLocked || !browser?.canGoBack}
            icon="back"
            label={copy.back}
            onClick={() => void navigate("back")}
          />
          <IconButton
            disabled={navigationLocked || !browser?.canGoForward}
            icon="forward"
            label={copy.forward}
            onClick={() => void navigate("forward")}
          />
          <IconButton disabled={navigationLocked || !visible} icon="reload" label={copy.reload} onClick={() => void navigate("reload")} />
        </div>
        <div className="browser-address" title={browser?.url || copy.browserAddress}>
          <Icon name="globe" />
          <span>{formatBrowserAddress(browser?.url, copy)}</span>
        </div>
        {providers.length > 1 ? (
          <div className="provider-switcher" role="group" aria-label="Web provider">
            {providers.map((item) => {
              const selected = item.id === activeProviderId;
              const runtimeId = runtimeProviderIdFor(item.id);
              const activeItemProfileId = item.activeProfileId || "default";
              const limitEntry = limitEntryByKey.get(`${runtimeId}::${activeItemProfileId}`);
              const tone = limitAlertTone(limitEntry?.status);
              const alertLabel = limitAlertBadgeText(limitEntry);
              return (
                <button
                  aria-disabled={switchingProvider || navigationLocked || undefined}
                  aria-pressed={selected}
                  className="provider-switcher-button"
                  key={item.id}
                  onClick={() => void switchProvider(item.id)}
                  title={`${item.displayName}${item.authenticated ? ` (${copy.signedIn})` : ""}${alertLabel ? ` · ${alertLabel}` : ""}`}
                  type="button"
                >
                  <span>{item.displayName}</span>
                  {tone ? <i aria-hidden="true" className={`provider-limit-dot is-${tone}`} /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {supportsProfiles && profiles.length > 0 ? (
          <div className="profile-switcher" role="group" aria-label="Provider profile switcher">
            <select
              aria-label="Active account profile"
              className="profile-switcher-select"
              disabled={profileControlLocked}
              onChange={(event) => void switchProfile(event.target.value)}
              title="Switch account profile"
              value={activeProfileId}
            >
              {profiles.map((profile) => {
                const limitEntry = limitEntryByKey.get(
                  `${runtimeProviderIdFor(activeProviderId)}::${profile.id}`,
                );
                const alertLabel = limitAlertBadgeText(limitEntry);
                return (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                    {profile.authenticated ? " ●" : " ○"}
                    {alertLabel ? ` (${alertLabel})` : ""}
                  </option>
                );
              })}
            </select>
            <IconButton
              disabled={profileControlLocked}
              icon="plus"
              label="Add account profile"
              onClick={() => void createQuickProfile()}
            />
          </div>
        ) : null}
        <div className="browser-zoom-controls">
          <IconButton icon="minus" label={copy.zoomOut} onClick={() => void zoom("out")} />
          <button
            aria-label={copy.zoomReset}
            className="browser-zoom-reset"
            onClick={() => void zoom("reset")}
            title={copy.zoomReset}
            type="button"
          >
            {Math.round((browser?.zoomFactor ?? 1) * 100)}%
          </button>
          <IconButton icon="plus" label={copy.zoomIn} onClick={() => void zoom("in")} />
          <IconButton
            disabled={!visible}
            icon="logs"
            label={copy.openBrowserDevTools}
            onClick={() => void openDevTools()}
          />
        </div>
        {(browser?.tabs ?? []).length > 0 ? (
          <button className="toolbar-text-button" onClick={() => void toggle()} type="button">
            {visible ? "Hide Browser" : "Show Browser"}
          </button>
        ) : null}
        {browser?.loading ? <i className="browser-loading-line" /> : null}
      </div>
      <div className="browser-viewport" ref={browserSlotRef}>
        {showExternalChromeCard ? (
          <div className="browser-empty browser-external-signin">
            <BrandMark />
            {externalLoginActive && externalLogin ? (
              <>
                <h1>Chrome opened for {externalLogin.profileName}</h1>
                <p>
                  {externalLogin.status === "importing"
                    ? `Importing your signed-in ${externalLogin.providerDisplayName || providerLabel} session into ${externalLogin.profileName}…`
                    : `Sign in to ${externalLogin.providerDisplayName || providerLabel} in the Google Chrome window, then click Import session.`}
                </p>
                <div className="browser-empty-actions">
                  <PrimaryButton
                    disabled={externalLoginBusy || externalLogin.status === "importing"}
                    onClick={() => void completeExternalChromeLogin()}
                  >
                    {externalLogin.status === "importing" ? "Importing..." : "Import session"}
                  </PrimaryButton>
                  <SecondaryButton
                    disabled={externalLoginBusy || externalLogin.status === "importing"}
                    onClick={() => void cancelExternalChromeLogin()}
                  >
                    Cancel
                  </SecondaryButton>
                </div>
              </>
            ) : (
              <>
                <h1>Sign in to {providerLabel} ({activeProfile?.name || "Default"})</h1>
                <p>{providerLabel} signs in through your system Google Chrome window and keeps each profile isolated.</p>
                <div className="browser-empty-actions">
                  <PrimaryButton
                    disabled={externalLoginBusy || navigationLocked}
                    onClick={() => void startExternalChromeLogin(activeProviderId, activeProfileId)}
                  >
                    Sign in with Chrome
                  </PrimaryButton>
                  {(browser?.tabs ?? []).length > 0 && !visible ? (
                    <SecondaryButton onClick={() => void toggle()}>
                      Show Browser
                    </SecondaryButton>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ) : !visible ? (
          <div className="browser-empty">
            <BrandMark />
            <h1>{copy.noActiveTask}</h1>
            <p>Browser tabs ({providerLabel}) will appear here automatically when Codex starts a turn.</p>
            {(browser?.tabs ?? []).length > 0 ? (
              <div className="browser-empty-actions">
                <PrimaryButton onClick={() => void toggle()}>
                  Show Browser
                </PrimaryButton>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="browser-underlay" aria-hidden="true">
            <span>{copy.loading}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function SetupSurface({
  activateBrowser,
  browser,
  copy,
  devProfile,
  limitEntryByKey,
  operation,
  setError,
  snapshot,
  updateState,
}: {
  activateBrowser: (show?: boolean) => Promise<void>;
  browser: BrowserState | null;
  copy: Copy;
  devProfile: boolean;
  limitEntryByKey: Map<string, ProfileLimitEntry>;
  operation: OperationState | null;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [localBusy, setLocalBusy] = useState(false);
  const [newProfileNameByProvider, setNewProfileNameByProvider] = useState<Record<string, string>>({});
  const [renamingTarget, setRenamingTarget] = useState<{ providerId: string; profileId: string } | null>(null);
  const [renamingDraft, setRenamingDraft] = useState("");

  useEffect(() => {
    void api?.listProviders?.().catch(() => {});
  }, []);

  const providers = resolveProviders(browser, snapshot);
  const activeProviderId = browser?.provider || snapshot.state.selectedProvider || providers[0].id;
  const authMap = browser?.authenticatedByProvider || {};
  const smokeMap = snapshot.state.smokePassedByProvider || snapshot.smokePassedByProvider || {};
  const modelSummary = providers.map((item) => item.displayName).join(", ");
  const isRunningTurn = browser?.status === "running" || browser?.status === "testing";
  const globalActionDisabled = localBusy || operation?.status === "running" || isRunningTurn;

  const run = async (action: () => Promise<void>) => {
    if (globalActionDisabled) return;
    setLocalBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLocalBusy(false);
    }
  };

  const install = () => run(async () => {
    await api!.setupCore();
    updateState((await api!.snapshot()).state);
  });

  const uninstall = () => run(async () => {
    const result = await api!.uninstallIntegration();
    if (!result.cancelled) updateState(result.state);
  });

  return (
    <ContentSurface
      eyebrow={copy.required}
      subtitle={devProfile
        ? copy.devSetupSubtitle
        : providers.length > 1
          ? "Sign in and verify web providers to work with Codex."
          : `Configure ${providers[0].displayName} to work with Codex.`}
      title={devProfile ? copy.devSetupTitle : "Set up Codex Web Providers"}
    >
      {providers.map((provider, providerIndex) => {
        const isActiveProvider = provider.id === activeProviderId;
        const activeProfileAuth = provider.supportsProfiles
          ? provider.profiles?.find((item) => item.id === (provider.activeProfileId || "default"))?.authenticated
          : undefined;
        const isAuthed = Boolean(
          activeProfileAuth
          ?? authMap[provider.id]
          ?? provider.authenticated
          ?? (isActiveProvider && browser?.authenticated),
        );
        const isTesting = isActiveProvider && browser?.status === "testing";
        const isSmokePassed = Boolean(smokeMap[provider.id]?.passed);
        const signInIndex = providerIndex * 2 + 1;
        const smokeIndex = providerIndex * 2 + 2;

        const isExternalChromeProvider = provider.usesExternalChromeLogin === true || provider.id === "ai-studio";
        const newProfileName = newProfileNameByProvider[provider.id] || "";

        return (
          <div className="setup-provider-group" key={provider.id}>
            <SectionHeading label={`${provider.displayName} Setup`} spaced={providerIndex > 0} />
            <div className="setup-list">
              <SetupRow
                action={isAuthed
                  ? copy.signedIn
                  : browser?.status === "loading" && isActiveProvider
                    ? copy.checkingSignIn
                    : (isExternalChromeProvider ? "Sign in with Chrome" : copy.signIn)}
                complete={isAuthed}
                description={isExternalChromeProvider
                  ? `Sign in through your system Google Chrome browser. Session stays isolated per ${provider.displayName} profile.`
                  : `Sign in directly in the embedded ${provider.displayName} browser. Login stays in this launcher's private profile.`}
                disabled={globalActionDisabled}
                index={signInIndex}
                onAction={() => run(async () => {
                  await activateBrowser();
                  if (!isActiveProvider) await api!.switchProvider(provider.id);
                  await api!.openLogin(provider.id);
                })}
                title={`Sign in to ${provider.displayName}`}
              />
              <SetupRow
                action={isSmokePassed ? "Verify again" : "Run verify"}
                complete={isSmokePassed}
                description={`Send smoke test prompt 'Reply with exactly: CODEX WEB GPT READY' to ${provider.displayName} and verify response.`}
                disabled={globalActionDisabled || isTesting || !isAuthed}
                index={smokeIndex}
                onAction={() => run(async () => {
                  await activateBrowser();
                  if (!isActiveProvider) await api!.switchProvider(provider.id);
                  await api!.smokeTest(provider.id);
                  updateState((await api!.snapshot()).state);
                })}
                repeatable={true}
                title={`Run browser smoke test (${provider.displayName})`}
              />
            </div>
            {provider.supportsProfiles ? (() => {
              const savedGroup = snapshot.state.providerProfiles?.[provider.id];
              const providerProfiles = provider.profiles?.length
                ? provider.profiles
                : savedGroup?.profiles ?? [{ id: "default", name: "Default", authenticated: isAuthed }];
              const currentProfileId = provider.activeProfileId || savedGroup?.activeProfileId || "default";
              return (
                <div className="profile-manager">
                  <div className="profile-manager-header">
                    <span>Account Profiles</span>
                    <div className="profile-manager-add">
                      <input
                        className="profile-name-input"
                        disabled={globalActionDisabled}
                        maxLength={40}
                        onChange={(event) => setNewProfileNameByProvider((prev) => ({
                          ...prev,
                          [provider.id]: event.target.value,
                        }))}
                        placeholder="Account name (optional)"
                        type="text"
                        value={newProfileName}
                      />
                      <SecondaryButton
                        disabled={globalActionDisabled}
                        onClick={() => void run(async () => {
                          const created = await api!.createProviderProfile(provider.id, newProfileName.trim());
                          setNewProfileNameByProvider((prev) => ({ ...prev, [provider.id]: "" }));
                          await activateBrowser();
                          await api!.openLogin(provider.id, created.profile.id);
                        })}
                      >
                        Add profile
                      </SecondaryButton>
                    </div>
                  </div>
                  <div className="profile-manager-list">
                    {providerProfiles.map((profile) => {
                      const isCurrentProfile = profile.id === currentProfileId;
                      const isEditing =
                        renamingTarget?.providerId === provider.id
                        && renamingTarget?.profileId === profile.id;
                      return (
                        <div className={`profile-row${isCurrentProfile ? " is-active" : ""}`} key={profile.id}>
                          <div className="profile-row-info">
                            <StateDot state={profile.authenticated ? "ready" : "idle"} />
                            {isEditing ? (
                              <input
                                autoFocus
                                className="profile-name-input is-inline"
                                maxLength={40}
                                onChange={(event) => setRenamingDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    if (event.nativeEvent.isComposing) return;
                                    event.preventDefault();
                                    void run(async () => {
                                      await api!.renameProviderProfile(provider.id, profile.id, renamingDraft);
                                      setRenamingTarget(null);
                                    });
                                  } else if (event.key === "Escape") {
                                    setRenamingTarget(null);
                                  }
                                }}
                                type="text"
                                value={renamingDraft}
                              />
                            ) : (
                              <>
                                <strong className="profile-row-name">{profile.name}</strong>
                                {isCurrentProfile ? <span className="profile-active-badge">Active</span> : null}
                                {(() => {
                                  const limitEntry = limitEntryByKey.get(
                                    `${runtimeProviderIdFor(provider.id)}::${profile.id}`,
                                  );
                                  const alertLabel = limitAlertBadgeText(limitEntry);
                                  const tone = limitAlertTone(limitEntry?.status);
                                  return alertLabel && tone ? (
                                    <span className={`profile-limit-pill is-${tone}`}>
                                      {alertLabel}
                                    </span>
                                  ) : null;
                                })()}
                              </>
                            )}
                          </div>
                          <div className="profile-row-actions">
                            {isEditing ? (
                              <>
                                <SecondaryButton
                                  disabled={globalActionDisabled || !renamingDraft.trim()}
                                  onClick={() => void run(async () => {
                                    await api!.renameProviderProfile(provider.id, profile.id, renamingDraft);
                                    setRenamingTarget(null);
                                  })}
                                >
                                  Save
                                </SecondaryButton>
                                <SecondaryButton
                                  onClick={() => setRenamingTarget(null)}
                                >
                                  Cancel
                                </SecondaryButton>
                              </>
                            ) : (
                              <>
                                {!isCurrentProfile ? (
                                  <SecondaryButton
                                    disabled={globalActionDisabled}
                                    onClick={() => void run(async () => {
                                      if (!isActiveProvider) await api!.switchProvider(provider.id);
                                      await api!.switchProviderProfile(provider.id, profile.id);
                                    })}
                                  >
                                    Use
                                  </SecondaryButton>
                                ) : null}
                                <SecondaryButton
                                  disabled={globalActionDisabled}
                                  onClick={() => void run(async () => {
                                    await activateBrowser();
                                    if (!isActiveProvider) await api!.switchProvider(provider.id);
                                    await api!.openLogin(provider.id, profile.id);
                                  })}
                                >
                                  {profile.authenticated ? "Open" : (isExternalChromeProvider ? "Sign in with Chrome" : "Sign in")}
                                </SecondaryButton>
                                <SecondaryButton
                                  disabled={globalActionDisabled}
                                  onClick={() => {
                                    setRenamingTarget({ providerId: provider.id, profileId: profile.id });
                                    setRenamingDraft(profile.name);
                                  }}
                                >
                                  Rename
                                </SecondaryButton>
                                {profile.id !== "default" ? (
                                  <SecondaryButton
                                    disabled={globalActionDisabled}
                                    onClick={() => void run(async () => {
                                      await api!.deleteProviderProfile(provider.id, profile.id);
                                    })}
                                  >
                                    Delete
                                  </SecondaryButton>
                                ) : null}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })() : null}
          </div>
        );
      })}

      {/* ── Install Section ── */}
      <SectionHeading label={devProfile ? copy.devCoreSetup : copy.coreSetup} spaced />
      <div className="setup-list">
        <SetupRow
          action={snapshot.state.coreSetupComplete
            ? devProfile ? copy.devReinstall : copy.reinstall
            : devProfile ? copy.devInstall : copy.install}
          complete={snapshot.state.codexCatalogVerified === true}
          description={devProfile
            ? copy.devStepInstallBody
            : `Configure Codex to expose only installed adapter models (${modelSummary}).`}
          disabled={globalActionDisabled}
          index={providers.length * 2 + 1}
          onAction={install}
          repeatable
          title={devProfile ? copy.devStepInstall : copy.stepInstall}
        />
        {!devProfile && snapshot.state.coreSetupComplete ? (
          <SettingRow
            body={copy.uninstallIntegrationBody}
            label={copy.uninstallIntegration}
          >
            <SecondaryButton disabled={globalActionDisabled} onClick={() => void uninstall()}>
              {copy.uninstall}
            </SecondaryButton>
          </SettingRow>
        ) : null}
      </div>

      {!devProfile && snapshot.state.codexRestartRequired ? (
        <NoticeRow icon="alert" tone="warning">
          {copy.restartCodex}
        </NoticeRow>
      ) : null}
    </ContentSurface>
  );
}

function SettingsSurface({
  copy,
  devProfile,
  language,
  setError,
  snapshot,
  updateState,
}: {
  copy: Copy;
  devProfile: boolean;
  language: Language;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnsCancelled, setTurnsCancelled] = useState(false);
  const [integrationRemoved, setIntegrationRemoved] = useState(false);

  const updateLanguage = async (next: Language) => {
    try {
      updateState(await api!.setLanguage(next));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const runDoctor = async () => {
    setBusy(true);
    try {
      setDoctor(await api!.doctor());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const openSwagger = async () => {
    setBusy(true);
    setError(null);
    try {
      await api!.openSwagger();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const cancelTurns = async () => {
    setBusy(true);
    setError(null);
    try {
      await api!.cancelTurns();
      setTurnsCancelled(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setSkillAttachments = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setSkillAttachments(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setUseSavedChats = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setUseSavedChats(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const uninstallIntegration = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api!.uninstallIntegration();
      if (!result.cancelled) {
        updateState(result.state);
        setIntegrationRemoved(true);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ContentSurface narrow title={devProfile ? copy.devSettingsTitle : copy.settingsTitle}>
      <SectionHeading label={copy.general} />
      <div className="settings-list">
        {!devProfile ? <SettingRow body={copy.launchAtLoginBody} label={copy.launchAtLogin}>
          <Switch
            checked={snapshot.state.autoStart}
            onChange={(checked) => void api!.setAutostart(checked)
              .then((result) => updateState(result.state))
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow> : null}
        <SettingRow body={devProfile ? copy.devKeepRunningBody : copy.keepRunningOnCloseBody} label={copy.keepRunningOnClose}>
          <Switch
            checked={snapshot.state.keepRunningOnClose}
            onChange={(checked) => void api!.setPreference("keepRunningOnClose", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.showDuringTurnsBody} label={copy.showDuringTurns}>
          <Switch
            checked={snapshot.state.showBrowserDuringTurns}
            onChange={(checked) => void api!.setPreference("showBrowserDuringTurns", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.skillAttachmentsBody} label={copy.skillAttachments}>
          <Switch
            checked={snapshot.state.experimentalSkillAttachments}
            disabled={busy || !snapshot.state.coreSetupComplete}
            onChange={(checked) => void setSkillAttachments(checked)}
          />
        </SettingRow>
        <SettingRow body={copy.chooseLanguageHint} label={copy.language}>
          <LanguageMenu copy={copy} language={language} onChange={(next) => void updateLanguage(next)} />
        </SettingRow>
      </div>

      {!devProfile && snapshot.state.codexRestartRequired ? (
        <NoticeRow icon="alert" tone="warning">
          {copy.restartCodex}
        </NoticeRow>
      ) : null}

      <SectionHeading label={copy.diagnostics} spaced />
      <button className="diagnostic-row" disabled={busy} onClick={() => void runDoctor()} type="button">
        <Icon name="activity" />
        <span>
          <strong>{copy.runDoctor}</strong>
          <small>{doctor ? (doctor.ok ? copy.healthy : copy.needsAttention) : copy.status}</small>
        </span>
        <Icon name="chevron" />
      </button>
      {!devProfile ? <button className="diagnostic-row" disabled={busy || !snapshot.state.coreSetupComplete} onClick={() => void openSwagger()} type="button">
        <Icon name="external" />
        <span>
          <strong>{copy.openSwagger}</strong>
          <small>{snapshot.state.coreSetupComplete ? copy.openSwaggerBody : copy.openSwaggerSetupRequired}</small>
        </span>
        <Icon name="chevron" />
      </button> : null}
      {!devProfile ? <button className="diagnostic-row" disabled={busy} onClick={() => void cancelTurns()} type="button">
        <Icon name="close" />
        <span>
          <strong>{copy.cancelTurns}</strong>
          <small>{turnsCancelled ? copy.turnsCancelled : copy.cancelTurnsBody}</small>
        </span>
        <Icon name="chevron" />
      </button> : null}
      {!devProfile ? <button className="diagnostic-row" disabled={busy} onClick={() => void uninstallIntegration()} type="button">
        <Icon name="close" />
        <span>
          <strong>{copy.uninstallIntegration}</strong>
          <small>{integrationRemoved ? copy.integrationRemoved : copy.uninstallIntegrationBody}</small>
        </span>
        <Icon name="chevron" />
      </button> : null}
      {doctor ? <DoctorSummary copy={copy} language={language} report={doctor} /> : null}

      <div className="about-row">
        <BrandMark small />
        <span>
          <strong>{copy.product}</strong>
          <small>
            {devProfile ? `${copy.devBadge} · ${snapshot.profilePaths.coreHome} · ` : ""}
            {platformLabel(snapshot.platform)} · v{snapshot.version}
          </small>
        </span>
      </div>
    </ContentSurface>
  );
}

function ContentSurface({
  children,
  eyebrow,
  fit = false,
  full = false,
  narrow = false,
  subtitle,
  title,
}: {
  children: ReactNode;
  eyebrow?: string;
  fit?: boolean;
  full?: boolean;
  narrow?: boolean;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className="content-surface">
      <div className={`content-scroll${full ? " is-full" : ""}${narrow ? " is-narrow" : ""}${fit ? " is-fit" : ""}`}>
        <header className="surface-header">
          {eyebrow ? <span>{eyebrow}</span> : null}
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
        {children}
      </div>
    </section>
  );
}

function SetupRow({
  action,
  complete,
  description,
  disabled,
  index,
  onAction,
  onSecondaryAction,
  repeatable = false,
  secondaryAction,
  secondaryDisabled = false,
  title,
  titleAction,
}: {
  action: string;
  complete: boolean;
  description: string;
  disabled: boolean;
  index: number;
  onAction: () => void;
  onSecondaryAction?: () => void;
  repeatable?: boolean;
  secondaryAction?: string;
  secondaryDisabled?: boolean;
  title: string;
  titleAction?: ReactNode;
}) {
  return (
    <div className={`setup-row${complete ? " is-complete" : ""}`}>
      <span className="setup-index">{complete ? <Icon name="check" /> : index}</span>
      <div className="setup-row-copy">
        <div className="setup-row-heading">
          <strong>{title}</strong>
          {titleAction}
        </div>
        <p>{description}</p>
      </div>
      <div className="setup-actions">
        {secondaryAction && onSecondaryAction ? (
          <SecondaryButton disabled={secondaryDisabled || complete} onClick={onSecondaryAction}>
            {secondaryAction}
          </SecondaryButton>
        ) : null}
        <SecondaryButton disabled={disabled || (complete && !repeatable)} onClick={onAction}>
          {action}
        </SecondaryButton>
      </div>
    </div>
  );
}

function TutorialVideo({ copy, label, src }: { copy: Copy; label: string; src: string }) {
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const inlineVideo = useRef<HTMLVideoElement>(null);
  const expandedVideo = useRef<HTMLVideoElement>(null);
  const expandedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const active = expanded ? expandedVideo.current : inlineVideo.current;
    if (expanded) inlineVideo.current?.pause();
    if (paused) active?.pause();
    else if (active) void active.play().catch(() => { if (!cancelled) setPaused(true); });
    return () => { cancelled = true; };
  }, [expanded, paused]);

  const playbackControl = {
    "aria-label": `${label}: ${paused ? copy.playGuideVideo : copy.pauseGuideVideo}`,
    role: "button",
    tabIndex: 0,
    onClick: () => setPaused(value => !value),
    onKeyDown: (event: ReactKeyboardEvent<HTMLVideoElement>) => {
      if (event.repeat || (event.key !== " " && event.key !== "Enter")) return;
      event.preventDefault();
      setPaused(value => !value);
    },
  };

  const closeExpanded = () => {
    const currentTime = expandedVideo.current?.currentTime;
    if (inlineVideo.current && Number.isFinite(currentTime)) {
      inlineVideo.current.currentTime = currentTime ?? 0;
    }
    setExpanded(false);
  };

  useEffect(() => {
    if (!expanded) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExpanded();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expanded]);

  return (
    <>
      <div className="guide-media">
        <video {...playbackControl} autoPlay={!paused && !expanded} loop muted playsInline ref={inlineVideo} src={src} />
        <span aria-hidden="true" className={`guide-media-pause${paused ? " is-visible" : ""}`}>
          <Icon name="pause" />
        </span>
        <button
          aria-label={copy.expandGuideVideo}
          className="guide-media-expand"
          onClick={() => {
            expandedAt.current = inlineVideo.current?.currentTime ?? 0;
            setExpanded(true);
          }}
          type="button"
        >
          <Icon name="expand" />
        </button>
      </div>
      {expanded ? createPortal(
        <div
          aria-label={label}
          aria-modal="true"
          className="guide-media is-expanded"
          role="dialog"
        >
          <video
            {...playbackControl}
            autoPlay={!paused}
            loop
            muted
            onLoadedMetadata={(event) => {
              event.currentTarget.currentTime = expandedAt.current;
            }}
            playsInline
            ref={expandedVideo}
            src={src}
          />
          <span aria-hidden="true" className={`guide-media-pause${paused ? " is-visible" : ""}`}>
            <Icon name="pause" />
          </span>
          <button
            aria-label={copy.closeGuideVideo}
            autoFocus
            className="guide-media-close"
            onClick={closeExpanded}
            type="button"
          >
            <Icon name="close" />
          </button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function SectionHeading({ label, meta, spaced = false }: { label: string; meta?: string; spaced?: boolean }) {
  return (
    <div className={`section-heading${spaced ? " is-spaced" : ""}`}>
      <span>{label}</span>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}

function NoticeRow({
  children,
  icon,
  tone,
}: {
  children: ReactNode;
  icon: IconName;
  tone: "warning" | "success";
}) {
  return (
    <div className={`notice-row tone-${tone}`}>
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

function SettingRow({
  body,
  children,
  label,
}: {
  body: string;
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{label}</strong>
        <p>{body}</p>
      </div>
      {children}
    </div>
  );
}

function FieldRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="field-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function DoctorSummary({ copy, language, report }: { copy: Copy; language: Language; report: DoctorReport }) {
  const visibleChecks = report.ok
    ? report.checks.slice(-6)
    : report.checks.filter((check) => check.status !== "ok");
  return (
    <div className={`doctor-summary${report.ok ? " is-healthy" : ""}`}>
      <header>
        <Icon name={report.ok ? "check" : "activity"} />
        <strong>{report.ok ? copy.healthy : copy.needsAttention}</strong>
      </header>
      <div>
        {visibleChecks.map((check) => (
          <p key={check.id}>
            <StateDot state={check.status === "ok" ? "ready" : check.status === "warning" ? "busy" : "error"} />
            <span>{check.status === "ok"
              ? localizeRuntimeMessage(copy, check.message, check.id, language)
              : check.message}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

function WelcomeOption({
  active,
  detail,
  label,
  marker,
  onClick,
}: {
  active: boolean;
  detail: string;
  label: string;
  marker: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-checked={active}
      className={`welcome-option${active ? " is-active" : ""}`}
      onClick={onClick}
      role="radio"
      type="button"
    >
      <span>{marker}</span>
      <strong>{label}</strong>
      <small>{detail}</small>
      {active ? <Icon name="check" /> : null}
    </button>
  );
}

function WelcomeAction({
  complete,
  disabled,
  icon,
  label,
  onClick,
}: {
  complete: boolean;
  disabled?: boolean;
  icon: "github" | "x";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`welcome-option is-social${complete ? " is-complete" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span><Icon name={icon} /></span>
      <strong>{label}</strong>
      <Icon name={complete ? "check" : "external"} />
    </button>
  );
}

function PrimaryButton({
  children,
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="button-primary" disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  className,
  disabled = false,
  icon,
  onClick,
  style,
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  icon?: IconName;
  onClick: () => void;
  style?: CSSProperties;
}) {
  return (
    <button className={`button-secondary${className ? ` ${className}` : ""}`} disabled={disabled} onClick={onClick} style={style} type="button">
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

function IconButton({
  disabled = false,
  expanded,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  expanded?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      className="icon-button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon name={icon} />
    </button>
  );
}

function Switch({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      className={`switch${checked ? " is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
}

const languageOptions = (Object.keys(languages) as Language[]).map(value => ({ value, ...languages[value] }));

function LanguageMenu({ copy, language, onChange }: { copy: Copy; language: Language; onChange: (language: Language) => void }) {
  const [open, setOpen] = useState(false);
  const options = languageOptions;
  const selected = options.find((option) => option.value === language) ?? options[0];

  return (
    <div
      className={`language-menu${open ? " is-open" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="language-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{selected.label}</span>
        <Icon name="chevron" />
      </button>
      {open ? (
        <>
          <button
            aria-label={`${copy.close}: ${copy.language}`}
            className="language-menu-scrim"
            onClick={() => setOpen(false)}
            type="button"
          />
          <div aria-label={copy.language} className="language-menu-panel" role="listbox">
            {options.map((option) => (
              <button
                aria-selected={option.value === language}
                className={option.value === language ? "is-selected" : ""}
                key={option.value}
                onClick={() => {
                  setOpen(false);
                  if (option.value !== language) onChange(option.value);
                }}
                role="option"
                type="button"
              >
                <span>{option.label}</span>
                {option.value === language ? <Icon name="check" /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function StateDot({ state }: { state: "idle" | "ready" | "busy" | "error" }) {
  return <i aria-hidden="true" className={`state-dot is-${state}`} />;
}

function ActionDot({ pulse = false, tone }: { pulse?: boolean; tone: "required" | "optional" | "success" | "error" }) {
  return <i aria-hidden="true" className={`action-dot is-${tone}${pulse ? " is-pulse" : ""}`} />;
}

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark${small ? " is-small" : ""}`}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path
          d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

function ErrorToast({ copy, message, onDismiss }: { copy: Copy; message: string; onDismiss: () => void }) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="error-toast"
      exit={{ opacity: 0, y: 8 }}
      initial={{ opacity: 0, y: 8 }}
      transition={PANEL_TRANSITION}
    >
      <StateDot state="error" />
      <span>
        <strong>{copy.error}</strong>
        <p>{message}</p>
      </span>
      <button onClick={onDismiss} type="button">{copy.dismiss}</button>
    </motion.div>
  );
}

const STARTUP_LOADING_STEPS = [
  {
    id: "runtime",
    match: "Preparing local runtime",
    title: "Kiểm tra & đồng bộ gói thực thi (Runtime Bundle)",
    detail: "Xác thực chữ ký manifest và chuẩn bị môi trường thực thi cục bộ",
  },
  {
    id: "browser",
    match: "Initializing embedded browser",
    title: "Khởi tạo trình duyệt nhúng (Embedded Browser)",
    detail: "Khởi chạy máy chủ điều khiển và phiên trình duyệt cô lập",
  },
  {
    id: "auth",
    match: "Checking saved sign-in session",
    title: "Kiểm tra phiên đăng nhập đã lưu",
    detail: "Khôi phục trạng thái xác thực tài khoản tự động",
  },
  {
    id: "bridge",
    match: "Starting local bridge service",
    title: "Khởi động dịch vụ cầu nối & kết nối Codex",
    detail: "Đồng bộ cấu hình route và khởi chạy dịch vụ cầu nối cục bộ",
  },
] as const;

function StartupLoadingModal({
  operation,
  product,
  version,
}: {
  operation: OperationState;
  product: string;
  version: string;
}) {
  const matchedIndex = operation.name === "runtime-upgrade"
    ? 3
    : STARTUP_LOADING_STEPS.findIndex(step => step.match === operation.message);
  const activeStepIndex = matchedIndex >= 0 ? matchedIndex : 0;

  return (
    <motion.div
      animate={{ opacity: 1 }}
      aria-describedby="startup-loading-body"
      aria-labelledby="startup-loading-title"
      aria-live="polite"
      aria-modal="true"
      className="startup-loading-backdrop"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      role="dialog"
      transition={{ duration: 0.18 }}
    >
      <motion.section
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="startup-loading-card"
        exit={{ opacity: 0, scale: 0.98, y: 6 }}
        initial={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={PANEL_TRANSITION}
      >
        <header className="startup-loading-header">
          <div className="startup-loading-brand">
            <BrandMark small />
            <span>{product}</span>
            <small>v{version}</small>
          </div>
          <h2 id="startup-loading-title">Đang khởi động ứng dụng…</h2>
          <p className="startup-loading-body" id="startup-loading-body">
            Hệ thống đang chuẩn bị môi trường làm việc và kết nối các dịch vụ nền. Vui lòng đợi trong giây lát.
          </p>
        </header>

        <div className="startup-loading-steps" role="list">
          {STARTUP_LOADING_STEPS.map((step, index) => {
            const state = index < activeStepIndex
              ? "complete"
              : index === activeStepIndex
                ? "active"
                : "pending";
            return (
              <div
                className={`startup-loading-step is-${state}`}
                key={step.id}
                role="listitem"
              >
                <span className="startup-loading-step-marker" aria-hidden="true">
                  {state === "complete" ? (
                    <Icon name="check" />
                  ) : state === "active" ? (
                    <StateDot state="busy" />
                  ) : (
                    `0${index + 1}`
                  )}
                </span>
                <div className="startup-loading-step-copy">
                  <strong>{step.title}</strong>
                  <p>{step.detail}</p>
                </div>
              </div>
            );
          })}
        </div>

        <footer className="startup-loading-footer">
          <div className="startup-loading-bar" aria-hidden="true">
            <span
              style={{
                width: `${Math.min(100, Math.round(((activeStepIndex + 1) / STARTUP_LOADING_STEPS.length) * 100))}%`,
              }}
            />
          </div>
          <small>{operation.message}</small>
        </footer>
      </motion.section>
    </motion.div>
  );
}

function McpMark() {
  return <i aria-hidden="true" className="mcp-mark" />;
}

function LaunchLoading() {
  return (
    <main className="launch-loading">
      <BrandMark />
      <span />
    </main>
  );
}

function FatalMessage({ message }: { message: string }) {
  return (
    <main className="fatal-message">
      <BrandMark />
      <h1>Codex Web GPT</h1>
      <p>{message}</p>
    </main>
  );
}

function browserTabTitleFromTitle(value: string | undefined, copy: Copy): string {
  const title = value?.trim();
  if (!title || title === "about:blank" || title.includes("codex-web-gpt-browser-host")) return copy.temporaryChat;
  return title.replace(/\s*[|—–-]\s*(ChatGPT|Microsoft Copilot|Copilot)\s*$/i, "") || copy.temporaryChat;
}

function browserTabTone(status: BrowserState["tabs"][number]["status"]): "idle" | "ready" | "busy" | "error" {
  if (status === "error" || status === "aborted") return "error";
  if (status === "loading" || status === "running" || status === "testing") return "busy";
  if (status === "ready") return "ready";
  return "idle";
}

function formatBrowserAddress(url: string | undefined, copy: Copy): string {
  if (!url || url.startsWith("about:blank")) return copy.browserAddress;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "chatgpt.com" && parsed.searchParams.get("temporary-chat") === "true") {
      return `chatgpt.com  /  ${copy.temporaryChat}`;
    }
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return copy.browserAddress;
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function platformLabel(value: string): string {
  return value === "darwin" ? "macOS" : value === "win32" ? "Windows" : value === "linux" ? "Linux" : value;
}

function humanEvent(value: string): string {
  return value.split(".").map((part) => part.replaceAll("_", " ")).join(" · ");
}

function logDetail(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return "";
  return entries
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

function formatTime(value: string, language: Language): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(languages[language].locale, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}
