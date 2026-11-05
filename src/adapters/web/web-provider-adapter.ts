import type { IncomingMeta, ProviderAdapter } from "../base";
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

  async close(): Promise<void> {
    if (this.localBrowser) {
      await this.localBrowser.close();
    }
  }
}
