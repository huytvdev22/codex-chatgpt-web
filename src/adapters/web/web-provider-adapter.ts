import type {
  IncomingMeta,
  ManagedTurnRequest,
  ManagedTurnResult,
  ProviderAdapter,
  RawTurnRequest,
  RawTurnResult,
  UsageLimitCheckRequest,
} from "../base";
import type { ProviderLimitCheckResult } from "../../limits/types";
import type { DiscoveredModelEntry } from "../../models/types";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { LocalBrowserRuntime } from "./local-browser-runtime";
import type { WebProviderDefinition } from "./definition";
import { WebTurnEngine } from "./engine";

/**
 * Base Adapter dùng chung triển khai ProviderAdapter interface,
 * ủy quyền toàn bộ vòng đời thực thi lượt cho WebTurnEngine.
 */
export class WebProviderAdapter implements ProviderAdapter {
  readonly name: string;
  protected readonly engine: WebTurnEngine;

  constructor(
    protected readonly definition: WebProviderDefinition,
    protected readonly localBrowser?: LocalBrowserRuntime,
  ) {
    this.name = definition.id;
    this.engine = new WebTurnEngine(definition, localBrowser);
  }

  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void> {
    await this.engine.runTurn(parsed, incoming, emit);
  }

  async runRawTurn(
    request: RawTurnRequest,
    incoming: IncomingMeta,
  ): Promise<RawTurnResult> {
    return await this.engine.runRawTurn(request, incoming);
  }

  async runManagedTurn(
    request: ManagedTurnRequest,
    incoming: IncomingMeta,
  ): Promise<ManagedTurnResult> {
    return await this.engine.runManagedTurn(request, incoming);
  }

  async discoverModels(incoming?: IncomingMeta): Promise<DiscoveredModelEntry[]> {
    return await this.engine.discoverModels(incoming);
  }

  async checkUsageLimit(
    request?: UsageLimitCheckRequest,
    incoming?: IncomingMeta,
  ): Promise<ProviderLimitCheckResult> {
    return await this.engine.checkUsageLimit(request, incoming);
  }

  async close(): Promise<void> {
    if (this.localBrowser) {
      await this.localBrowser.close();
    }
  }
}
