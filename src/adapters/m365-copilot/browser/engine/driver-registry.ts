import type { PageDriver } from "../contracts/page-driver";
import { logFunctionInput } from "../../debug-logger";

const registry = new Map<string, PageDriver>();

/**
 * Đăng ký một PageDriver vào hệ sinh thái.
 */
export function registerPageDriver(driver: PageDriver): void {
  logFunctionInput("browser:engine:driver-registry", "registerPageDriver", { id: driver.id, name: driver.name });
  registry.set(driver.id, driver);
}

/**
 * Lấy PageDriver theo định danh.
 */
export function getPageDriver(id: string): PageDriver | undefined {
  logFunctionInput("browser:engine:driver-registry", "getPageDriver", { id });
  return registry.get(id);
}

/**
 * Liệt kê danh sách tất cả các drivers đã đăng ký.
 */
export function listPageDrivers(): PageDriver[] {
  return Array.from(registry.values());
}
