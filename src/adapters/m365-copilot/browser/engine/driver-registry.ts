import type { PageDriver } from "../contracts/page-driver";
import { m365CopilotDriver } from "../drivers/m365-copilot-driver";
import { logFunctionInput } from "../../debug-logger";

const registry = new Map<string, PageDriver>();
let defaultDriverId = "m365-copilot";

// Đăng ký mặc định M365 Copilot Driver khi hệ thống khởi động
registry.set(m365CopilotDriver.id, m365CopilotDriver);

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
 * Thiết lập driver mặc định của hệ thống.
 */
export function setDefaultDriverId(id: string): void {
  defaultDriverId = id;
}

/**
 * Lấy định danh driver mặc định.
 */
export function getDefaultDriverId(): string {
  return defaultDriverId;
}

/**
 * Tự động phân giải PageDriver phù hợp dựa theo providerId hoặc modelSlug.
 */
export function resolvePageDriver(options?: {
  providerId?: string;
  modelSlug?: string;
} | string): PageDriver {
  const normalizedOpts = typeof options === "string" ? { providerId: options } : options;
  logFunctionInput("browser:engine:driver-registry", "resolvePageDriver", { options: normalizedOpts });

  // 1. Ưu tiên providerId nếu được chỉ định tường minh
  if (normalizedOpts?.providerId) {
    const driver = registry.get(normalizedOpts.providerId);
    if (driver) return driver;
  }

  // 2. Nhận diện theo prefix hoặc tên của modelSlug
  if (normalizedOpts?.modelSlug) {
    const slug = normalizedOpts.modelSlug.toLowerCase();
    for (const [id, driver] of registry.entries()) {
      if (slug.startsWith(`${id}/`) || slug.startsWith(`${id}-`) || slug.includes(id)) {
        return driver;
      }
    }
    if (slug.includes("bing")) {
      const bingDriver = registry.get("bing-copilot");
      if (bingDriver) return bingDriver;
    }
    if (slug.includes("studio")) {
      const studioDriver = registry.get("copilot-studio");
      if (studioDriver) return studioDriver;
    }
  }

  // 3. Fallback về default driver
  const defaultDriver = registry.get(defaultDriverId) || registry.values().next().value;
  if (!defaultDriver) {
    throw new Error(`Không tìm thấy PageDriver nào đã đăng ký trong hệ thống (default: ${defaultDriverId})`);
  }
  return defaultDriver;
}

/**
 * Liệt kê danh sách tất cả các drivers đã đăng ký.
 */
export function listPageDrivers(): PageDriver[] {
  return Array.from(registry.values());
}
