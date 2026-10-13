import type { Page } from "playwright-core";
import type { IDomDriver } from "../contracts/dom-driver.interface";

/**
 * Hiện thực hóa IDomDriver sử dụng Playwright Page (Hexagonal Adapter)
 */
export class PlaywrightDomDriver implements IDomDriver {
  constructor(private readonly page: Page) {}

  public getPage(): Page {
    return this.page;
  }

  public async evaluate<T, R>(fn: (param: T) => R | Promise<R>, arg: T): Promise<R>;
  public async evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  public async evaluate<T, R>(fn: ((param: T) => R | Promise<R>) | (() => R | Promise<R>), arg?: T): Promise<R> {
    if (arguments.length > 1) {
      return this.page.evaluate(fn as (param: T) => R | Promise<R>, arg as T);
    }
    return this.page.evaluate(fn as () => R | Promise<R>);
  }

  public async waitForSelector(selector: string, timeoutMs: number): Promise<boolean> {
    try {
      await this.page.waitForSelector(selector, { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  public async click(selector: string, timeoutMs?: number): Promise<boolean> {
    try {
      await this.page.click(selector, { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  public async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key).catch(() => {});
  }

  public async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}
