import languages from "../electron/languages.json";

export type Language = keyof typeof languages;
export type LauncherProfile = "production" | "development";
export type Surface = "browser" | "setup" | "models" | "settings" | "personalization" | "skills" | "usage";

export type UsageRange = "today" | "7d" | "30d" | "all";
export type TokenSourceKind = "ai-studio-dom" | "tiktoken";

export interface UsageSettings {
  version: 1;
  showChatFooter: boolean;
  updatedAt: string | null;
}

export interface UsageGroupSummary {
  key: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalDurationMs: number;
  lastContextTokens: number | null;
  lastTimestamp: string;
}

export interface PromptBreakdownMetrics {
  toolDeclarationChars: number;
  developerChars: number;
  historyChars: number;
  toolResultsChars: number;
  environmentChars: number;
  userRequestChars: number;
  finalPromptChars: number;
}

export interface UsageTurnRecord {
  id: string;
  timestamp: string;
  providerId: string;
  modelId: string;
  threadId?: string;
  conversationKey?: string;
  scenario?: string;
  status: "completed" | "failed";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens?: number;
  tokenSource: TokenSourceKind;
  durationMs: number;
  attempts: number;
  breakdown?: PromptBreakdownMetrics;
}

export interface UsageSummary {
  range: UsageRange;
  totals: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    avgDurationMs: number;
    lastContextTokens: number | null;
  };
  byProvider: UsageGroupSummary[];
  byModel: UsageGroupSummary[];
  recentTurns: UsageTurnRecord[];
}

export type ModelReasoningEffort = "low" | "medium" | "high";
export type ModelInputModality = "text" | "image";

export interface ManagedModelDefaults {
  enabled: boolean;
  displayName: string;
  description: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  effectiveContextWindowPercent: number;
  inputModalities: ModelInputModality[];
  defaultReasoningLevel: ModelReasoningEffort;
}

export interface ManagedModelView {
  slug: string;
  providerId: string;
  source: "builtin" | "discovered";
  available: boolean;
  enabled: boolean;
  effectiveEnabled: boolean;
  customized: boolean;
  displayName: string;
  description: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  effectiveContextWindowPercent: number;
  inputModalities: ModelInputModality[];
  defaultReasoningLevel: ModelReasoningEffort;
  supportedReasoningLevels: ModelReasoningEffort[];
  defaults: ManagedModelDefaults;
}

export interface ManagedProviderGroupView {
  providerId: string;
  lastRefreshedAt: string | null;
  lastError: string | null;
  enabledCount: number;
  availableCount: number;
  totalCount: number;
  models: ManagedModelView[];
}

export interface ManagedModelsSnapshot {
  version: 1;
  updatedAt: string | null;
  configPath: string;
  totalEnabledCount: number;
  providers: ManagedProviderGroupView[];
}

export interface ProviderRefreshResult {
  providerId: string;
  status: "ok" | "busy" | "error";
  addedCount: number;
  updatedCount: number;
  unavailableCount: number;
  discoveredCount: number;
  autoEnabledSlug?: string;
  message?: string;
}

export interface ModelOverridePatch {
  enabled?: boolean;
  displayName?: string;
  contextWindow?: number;
  inputModalities?: ModelInputModality[];
  defaultReasoningLevel?: ModelReasoningEffort;
}

export interface UsageStatePayload {
  settings: UsageSettings;
  summary: UsageSummary;
}

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

export interface SuggestedSkillDirectory {
  path: string;
  resolvedPath: string;
  skillCount: number;
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

export interface SkillsStatePayload {
  settings: SkillsSettings;
  directories: ScannedSkillDirectory[];
  suggestedDirectories: SuggestedSkillDirectory[];
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

export interface BrowserProfileInfo {
  id: string;
  name: string;
  authenticated: boolean;
}

export interface ProviderProfilesGroup {
  activeProfileId: string;
  profiles: BrowserProfileInfo[];
}

export interface BrowserProviderInfo {
  id: string;
  displayName: string;
  homeUrl: string;
  partition: string;
  active: boolean;
  authenticated: boolean;
  supportsProfiles?: boolean;
  usesExternalChromeLogin?: boolean;
  activeProfileId?: string;
  profiles?: BrowserProfileInfo[];
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
  providerProfiles?: Record<string, ProviderProfilesGroup>;
  sessionRefreshReminderAt: string | null;
  selectedProvider: string;
}

export interface ExternalLoginState {
  active: boolean;
  status: "waiting" | "importing";
  providerId: string;
  providerDisplayName?: string;
  profileId: string;
  profileName: string;
}

export interface BrowserState {
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error";
  message: string;
  url: string;
  title: string;
  authenticated: boolean;
  authenticatedByProvider?: Record<string, boolean>;
  providers?: BrowserProviderInfo[];
  externalLogin?: ExternalLoginState | null;
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
  profileId?: string;
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
  switchProviderProfile(providerId: string, profileId: string): Promise<BrowserState>;
  createProviderProfile(
    providerId: string,
    name?: string,
  ): Promise<{ snapshot: BrowserState; profile: BrowserProfileInfo }>;
  renameProviderProfile(
    providerId: string,
    profileId: string,
    name: string,
  ): Promise<{ snapshot: BrowserState; profile: BrowserProfileInfo }>;
  deleteProviderProfile(providerId: string, profileId: string): Promise<BrowserState>;
  openLogin(providerId?: string, profileId?: string): Promise<BrowserState>;
  startExternalLogin(providerId?: string, profileId?: string): Promise<BrowserState>;
  completeExternalLogin(): Promise<BrowserState>;
  cancelExternalLogin(): Promise<BrowserState>;
  smokeTest(
    providerId?: string,
    profileId?: string,
  ): Promise<{ ok: boolean; effort: string; response: string }>;
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
  pickSkillDirectory(): Promise<{ cancelled: boolean; path: string | null }>;
  openSkillDirectory(targetPath: string): Promise<{ ok: boolean; path: string }>;
  getUsage(range?: UsageRange): Promise<UsageStatePayload>;
  saveUsageSettings(settings: UsageSettings, range?: UsageRange): Promise<UsageStatePayload>;
  clearUsageHistory(range?: UsageRange): Promise<UsageStatePayload>;
  getModels(): Promise<ManagedModelsSnapshot>;
  updateModelOverride(slug: string, patch: ModelOverridePatch): Promise<ManagedModelsSnapshot>;
  toggleProviderModels(providerId: string, enabled: boolean): Promise<ManagedModelsSnapshot>;
  refreshModels(providerId?: string): Promise<{ snapshot: ManagedModelsSnapshot; results: ProviderRefreshResult[] }>;
  resetModels(slug?: string): Promise<ManagedModelsSnapshot>;
  openModelsConfig(): Promise<{ ok: boolean; path: string }>;
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
  onModelsChanged(listener: (snapshot: ManagedModelsSnapshot) => void): () => void;
}

declare global {
  interface Window {
    codexWebLauncher?: LauncherApi;
  }
}
