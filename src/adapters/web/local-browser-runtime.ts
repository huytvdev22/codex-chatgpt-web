import { mkdirSync } from "node:fs";
import type { BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";

export interface LocalBrowserRuntimeOptions {
  profileDir: string;
  headless?: boolean;
  logPrefix: string;
}

/**
 * Owns the provider-neutral persistent Chrome fallback used when no Launcher
 * surface is available. Provider adapters retain responsibility for deciding
 * whether falling back to local Chrome is allowed.
 */
export class LocalBrowserRuntime {
  private browserContext: BrowserContext | null = null;
  private activePage: Page | null = null;

  constructor(private readonly options: LocalBrowserRuntimeOptions) {}

  async ensurePage(): Promise<Page> {
    if (this.activePage && !this.activePage.isClosed()) {
      return this.activePage;
    }

    mkdirSync(this.options.profileDir, { recursive: true });
    console.log(
      `[${this.options.logPrefix}] Khởi chạy Google Chrome local với profile: ${this.options.profileDir}`,
    );

    this.browserContext = await chromium.launchPersistentContext(
      this.options.profileDir,
      {
        channel: "chrome",
        headless: this.options.headless ?? false,
        viewport: { width: 1280, height: 800 },
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
        ],
      },
    );

    const pages = this.browserContext.pages();
    this.activePage = pages[0] || await this.browserContext.newPage();
    return this.activePage;
  }

  getActivePage(): Page | null {
    return this.activePage && !this.activePage.isClosed()
      ? this.activePage
      : null;
  }

  async close(): Promise<void> {
    if (!this.browserContext) return;

    await this.browserContext.close();
    this.browserContext = null;
    this.activePage = null;
  }

  async closeSafely(): Promise<void> {
    await this.close().catch(() => {});
  }
}
