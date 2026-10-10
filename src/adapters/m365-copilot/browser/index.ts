export {
  executeM365Turn,
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
