import type { ProviderAdapter } from "../../../base";
import type { IChatBrowserWorker } from "../../browser/contracts/chat-browser-worker.interface";
import type { IModelSelector } from "../../model-selection/contracts/model-selector.interface";

/**
 * Hợp đồng Adapter điều phối Web Chat cấp cao
 */
export interface IWebChatAdapter extends ProviderAdapter {
  readonly browserWorker: IChatBrowserWorker;
  readonly modelSelector?: IModelSelector;
}
