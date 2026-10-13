export {
  executeM365Turn,
  type M365TurnOptions,
  type M365TurnResult,
  CHAT_SELECTORS,
  M365_CHAT_EDITOR_SELECTOR,
} from "./browser-worker";

export {
  M365BrowserWorker,
  defaultM365BrowserWorker,
} from "./m365-browser-worker";

export {
  M365CapabilityPicker,
  type M365CapabilityMode,
  ensureM365CapabilityMode,
  resolveM365CapabilityMode,
  defaultCapabilityPicker,
} from "./capability-picker";

export {
  M365_CAPABILITY_SPECS,
  M365_MODEL_SPECS_MAP,
  type M365CapabilitySpec,
} from "./m365-capability-specs";

export { M365ModelVerifier } from "./m365-model-verifier";

export {
  attachFilesViaPlusMenu,
  m365ImageFilePayloads,
  PLUS_MENU_SELECTORS,
  type M365ImagePayload,
  type AttachFilesOptions,
} from "./attachments";

export { m365ConversationKey } from "./conversation-key";

export {
  M365_CHAT_URL,
  M365_CONVERSATION_ORIGIN,
  parseM365ConversationId,
  waitForM365ConversationId,
} from "./conversation-url";
