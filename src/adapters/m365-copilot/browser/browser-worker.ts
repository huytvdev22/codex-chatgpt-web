import {
  M365BrowserWorker,
  M365_CHAT_EDITOR_SELECTOR,
  CHAT_SELECTORS,
} from "./m365-browser-worker";
import { CdpLauncherConnector, ClipboardCopySalvager } from "../../base-web/browser";
import type { TraceContext } from "../../../observability/types";
import type { NormalizedImageAttachment } from "../normalization/canonical-types";
import type { M365MarkdownBlock } from "../translation/semantic-detector";

export interface M365BrowserRunOptions {
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  descriptorPath?: string;
  traceId?: string;
  conversationKey?: string;
  isNewConversation?: boolean;
  shouldStop?: () => boolean;
  modelSlug?: string;
  reasoning?: string;
  traceContext?: TraceContext;
  images?: NormalizedImageAttachment[];
}

export type M365TurnOptions = M365BrowserRunOptions;
export type M365TurnResult = { rawMarkdown: string; blocks: M365MarkdownBlock[] };

export {
  M365_CHAT_EDITOR_SELECTOR,
  CHAT_SELECTORS,
  M365BrowserWorker,
};

/**
 * Xác định đường dẫn file descriptor của Launcher Browser Host
 */
export function resolveDescriptorPath(customPath?: string): string {
  return CdpLauncherConnector.resolveDescriptorPath(customPath);
}

const defaultSalvager = new ClipboardCopySalvager({
  aiMessageSelector: ".fai-CopilotMessage, [data-content='ai-message'], .fui-ChatMessage, [role='article']",
  userMessageSelector: "[data-content='user-message']",
  codeBlockSelector: ".scriptor-component-code-block, [class*='code-block' i], [data-testid='one-copilot-code-identity'], .djlfcDli",
  copyButtonSelector: "button#copy-button, button[aria-label='Copy code']",
  previewToggleSelector: "button#preview-toggle-button, button[data-automation-id='codePreviewToggle'], button[aria-label='Code'], button[aria-label*='Code' i]",
});

export async function tryExtractCodeViaCopyButton(page: any): Promise<string | null> {
  return defaultSalvager.salvage(page);
}

/**
 * Thực thi một lượt hội thoại với Microsoft 365 Copilot trên trình duyệt
 * Ủy quyền cho M365BrowserWorker (kế thừa BaseChatBrowserWorker chuẩn OOP Template Method)
 */
export async function executeM365Turn(
  promptText: string,
  options: M365BrowserRunOptions
): Promise<string> {
  const worker = new M365BrowserWorker();
  return worker.executeTurn(promptText, options as any);
}
