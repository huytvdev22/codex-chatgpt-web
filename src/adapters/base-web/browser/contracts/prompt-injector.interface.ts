import type { Page } from "playwright-core";
import type { ChatSelectorsDto } from "../dto/chat-selectors.dto";
import type { BrowserTurnOptionsDto } from "../dto/browser-turn-options.dto";

/**
 * Hợp đồng bơm nội dung prompt và attachments vào editor của web chat
 */
export interface IPromptInjector {
  inject(page: Page, prompt: string, selectors: ChatSelectorsDto, options: BrowserTurnOptionsDto): Promise<void>;
}
