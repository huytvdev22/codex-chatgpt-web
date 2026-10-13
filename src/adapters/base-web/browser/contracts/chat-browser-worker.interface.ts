import type { BrowserTurnOptionsDto } from "../dto/browser-turn-options.dto";

/**
 * Hợp đồng dịch vụ thực thi tương tác trên trình duyệt (Public Worker Interface)
 */
export interface IChatBrowserWorker {
  readonly workerName: string;
  executeTurn(prompt: string, options: BrowserTurnOptionsDto): Promise<string>;
}
