import type { Page } from "playwright-core";
import type { ChatSelectorsDto } from "../dto/chat-selectors.dto";
import type { BrowserTurnOptionsDto } from "../dto/browser-turn-options.dto";

/**
 * Hợp đồng quan sát Live DOM và thu thập luồng streaming văn bản từ bot
 */
export interface IStreamObserver {
  observe(page: Page, selectors: ChatSelectorsDto, options: BrowserTurnOptionsDto): Promise<string>;
}
