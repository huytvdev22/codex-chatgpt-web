import languages from "../electron/languages.json";

export type Language = keyof typeof languages;
export type LauncherProfile = "production" | "development";
export type Surface = "browser" | "setup" | "settings" | "personalization" | "skills";

export type SkillSourceKind = "workspace" | "user" | "system" | "unknown";

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

export interface SkillsStatePayload {
  settings: SkillsSettings;
  discoveredSkills: DiscoveredSkillRecord[];
}

export type PersonalizationTone =
  | "default"
  | "concise_technical"
  | "friendly"
  | "formal"
  | "mentor";

export interface SavedMemoryItem {
  id: string;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalizationSettings {
  version: 1;
  enabled: boolean;
  workspaceMemoryEnabled: boolean;
  baseTone: PersonalizationTone;
  nickname: string;
  roleOrStack: string;
  aboutYou: string;
  customInstructions: string;
  memories: SavedMemoryItem[];
  updatedAt: string | null;
}

export interface BrowserProviderInfo {
  id: string;
  displayName: string;
  homeUrl: string;
  partition: string;
  active: boolean;
  authenticated: boolean;
}

export interface ProviderSmokeStatus {
  passed: boolean;
  version: string | null;
}

export interface LauncherState {
  version: 1;
  language: Language | null;
  onboardingComplete: boolean;
  githubOpened: boolean;
  xOpened: boolean;
  autoStart: boolean;
  keepRunningOnClose: boolean;
  showBrowserDuringTurns: boolean;
  experimentalBiggerContext: boolean;
  experimentalSkillAttachments: boolean;
  experimentalFreshConversationPerTurn: boolean;
  useSavedChats: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  browserSmokePassed?: boolean;
  browserSmokeVersion?: string | null;
  smokePassedByProvider?: Record<string, ProviderSmokeStatus>;
  coreSetupComplete?: boolean;
  codexCatalogVerified?: boolean;
  codexRestartRequired?: boolean;
  sessionRefreshReminderAt: string | null;
  selectedProvider: string;
}

export interface BrowserState {
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error";
  message: string;
  url: string;
  title: string;
  authenticated: boolean;
  authenticatedByProvider?: Record<string, boolean>;
  providers?: BrowserProviderInfo[];
  visible: boolean;
  surfaceActive: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  activeTabId: string;
  maxTabs: number;
  provider?: string;
  tabs: BrowserTabState[];
}

export interface BrowserTabState {
  id: string;
  traceId: string | null;
  title: string;
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error" | "aborted";
  loading: boolean;
  active: boolean;
  closable: boolean;
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: "browser-only" | "full";
  checks: DoctorCheck[];
}

export interface OperationState {
  name: string;
  status: "running" | "completed" | "failed";
  message: string;
}

export type UpdateState =
  | { status: "disabled" | "idle" | "checking" | "up-to-date" }
  | { status: "available" | "downloading" | "installing"; version: string }
  | { status: "error"; message: string };

export interface LauncherSnapshot {
  profile: LauncherProfile;
  profilePaths: {
    coreHome: string;
    codexHome: string;
    userData: string;
  };
  state: LauncherState;
  browser: BrowserState | null;
  providers?: BrowserProviderInfo[];
  connectorName: string;
  urls: {
    github: string;
    x: string;
  };
  platform: string;
  packaged: boolean;
  version: string;
  smokePassed: boolean;
  smokePassedByProvider?: Record<string, ProviderSmokeStatus>;
  operation: OperationState | null;
  update: UpdateState;
}

export interface LauncherApi {
  snapshot(): Promise<LauncherSnapshot>;
  setLanguage(language: Language): Promise<LauncherState>;
  openSocial(target: "github" | "x"): Promise<LauncherState>;
  completeOnboarding(language: Language): Promise<LauncherState>;
  openExternal(url: string): Promise<boolean>;
  setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  setBrowserSurfaceActive(active: boolean): Promise<BrowserState>;
  showBrowser(): Promise<BrowserState>;
  hideBrowser(): Promise<BrowserState>;
  navigateBrowser(action: "back" | "forward" | "reload"): Promise<BrowserState>;
  openBrowserDevTools(): Promise<boolean>;
  zoomBrowser(action: "in" | "out" | "reset"): Promise<BrowserState>;
  selectBrowserTab(tabId: string): Promise<BrowserState>;
  closeBrowserTab(tabId: string): Promise<BrowserState>;
  listProviders(): Promise<BrowserProviderInfo[]>;
  switchProvider(providerId: string): Promise<BrowserState>;
  openLogin(providerId?: string): Promise<BrowserState>;
  smokeTest(providerId?: string): Promise<{ ok: boolean; effort: string; response: string }>;
  doctor(): Promise<DoctorReport>;
  openSwagger(): Promise<{ url: string }>;
  cancelTurns(): Promise<{ stdout: string }>;
  uninstallIntegration(): Promise<{ cancelled: true } | { cancelled: false; state: LauncherState }>;
  setupCore(): Promise<{ ok: boolean; stdout: string; restartRequired: boolean }>;
  setConnectorNameSuffix(suffix: string): Promise<LauncherState>;
  setAutostart(enabled: boolean): Promise<{ state: LauncherState; supported: boolean; enabled: boolean }>;
  setBiggerContext(enabled: boolean): Promise<LauncherState>;
  setSkillAttachments(enabled: boolean): Promise<LauncherState>;
  setFreshConversationPerTurn(enabled: boolean): Promise<LauncherState>;
  setUseSavedChats(enabled: boolean): Promise<LauncherState>;
  setPreference(
    key: "keepRunningOnClose" | "showBrowserDuringTurns",
    value: boolean,
  ): Promise<LauncherState>;
  getPersonalization(): Promise<PersonalizationSettings>;
  savePersonalization(settings: PersonalizationSettings): Promise<PersonalizationSettings>;
  getSkills(): Promise<SkillsStatePayload>;
  saveSkills(settings: SkillsSettings): Promise<SkillsStatePayload>;
  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;
  installUpdate(): Promise<boolean>;
  windowState(): Promise<{ fullScreen: boolean; maximized: boolean }>;
  windowControl(action: "close" | "minimize" | "zoom"): void;
  onWindowStateChanged(listener: (state: { fullScreen: boolean; maximized: boolean }) => void): () => void;
  onConnectorNameChanged(listener: (connectorName: string) => void): () => void;
  onStateChanged(listener: (state: LauncherState) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onOperation(listener: (state: OperationState) => void): () => void;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    codexWebLauncher?: LauncherApi;
  }
}
