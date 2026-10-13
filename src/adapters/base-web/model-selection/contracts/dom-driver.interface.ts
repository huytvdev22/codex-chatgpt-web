/**
 * Cổng giao tiếp trừu tượng hóa DOM (Hexagonal Architecture Port)
 * Tách biệt hoàn toàn Core Logic khỏi Playwright API
 */
export interface IDomDriver {
  evaluate<T, R>(fn: (param: T) => R | Promise<R>, arg: T): Promise<R>;
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  waitForSelector(selector: string, timeoutMs: number): Promise<boolean>;
  click(selector: string, timeoutMs?: number): Promise<boolean>;
  pressKey(key: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}
