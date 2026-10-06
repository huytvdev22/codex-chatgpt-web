export {
  executeM365Turn,
  CHAT_SELECTORS,
  type M365BrowserRunOptions,
  type M365TurnOptions,
  type M365TurnResult,
} from "./browser-worker";

export {
  M365CapabilityPicker,
  type M365CapabilityMode,
  ensureM365CapabilityMode,
  resolveM365CapabilityMode,
} from "./capability-picker";

export {
  type PageDriver,
  type BaselineState,
  type ScrapeProgressResult,
} from "./contracts/page-driver";

export {
  M365CopilotDriver,
} from "./drivers/m365-copilot-driver";

export {
  executeTurnWithDriver,
  registerPageDriver,
  getPageDriver,
  listPageDrivers,
} from "./engine";

export {
  connectCdpSurface,
  resolveDescriptorPath,
  withTimeout,
  notifyCdpTurnStart,
  notifyCdpTurnHeartbeat,
  notifyCdpTurnEnd,
} from "./cdp";
