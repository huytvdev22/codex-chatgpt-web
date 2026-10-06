import { logFunctionInput } from "../debug-logger";
import { executeTurnWithDriver } from "./engine/orchestrator";
import { M365CopilotDriver, CHAT_SELECTORS } from "./drivers/m365-copilot-driver";
import { registerPageDriver, getPageDriver } from "./engine/driver-registry";
import type {
  M365BrowserRunOptions,
  M365TurnOptions,
  M365TurnResult,
} from "./contracts/page-driver";

export {
  CHAT_SELECTORS,
  type M365BrowserRunOptions,
  type M365TurnOptions,
  type M365TurnResult,
};

// Đăng ký M365CopilotDriver mặc định vào Driver Registry
const defaultM365Driver = new M365CopilotDriver();
registerPageDriver(defaultM365Driver);

/**
 * Thực thi một lượt hội thoại với Microsoft 365 Copilot nhúng trong Launcher Desktop.
 * Facade điều phối cuộc gọi tới Turn Orchestrator cùng M365CopilotDriver.
 * Giữ nguyên 100% contract và signature cũ để bảo toàn tương thích ngược.
 */
export async function executeM365Turn(
  promptText: string,
  options: M365BrowserRunOptions
): Promise<string> {
  logFunctionInput("browser:browser-worker", "executeM365Turn", {
    promptLength: promptText.length,
    options,
  });
  const driver = getPageDriver("m365-copilot") || defaultM365Driver;
  return executeTurnWithDriver(driver, promptText, options);
}
