import type { Page } from "playwright-core";

/**
 * Hợp đồng cứu hộ mã nguồn từ DOM bị ảo hóa (Virtualization) qua nút Copy Code
 */
export interface ICodeSalvager {
  salvage(page: Page): Promise<string | null>;
}
