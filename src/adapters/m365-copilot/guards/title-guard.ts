import type { CodexParsedRequest } from "../../../types";
import { BaseTitleGuard } from "../../base-web/guards";

/**
 * Trình Title Guard chuyên biệt cho M365 Copilot.
 * Kế thừa BaseTitleGuard từ base-web và cấu hình provider name là "M365".
 */
export class M365TitleGuard extends BaseTitleGuard {
  constructor() {
    super({
      defaultProviderName: "M365",
      defaultSubject: "Coding Session",
      defaultDescription: "Phiên lập trình với M365 Copilot",
      envFlagNames: [
        "M365_ENABLE_TITLE_GUARD",
        "CODEX_M365_ENABLE_TITLE_GUARD",
        "ENABLE_TITLE_GUARD",
      ],
    });
  }
}

export const defaultM365TitleGuard = new M365TitleGuard();

export function isTitleGuardEnabled(customFlag?: boolean): boolean {
  return defaultM365TitleGuard.isEnabled(customFlag);
}

export function isTitleRequest(
  parsed: CodexParsedRequest,
  compiledPrompt: string,
  options?: { enableTitleGuard?: boolean }
): boolean {
  return defaultM365TitleGuard.isTitleRequest(parsed, compiledPrompt, options?.enableTitleGuard);
}

export function generateTitleResponse(compiledPrompt: string): string {
  return defaultM365TitleGuard.generateTitleResponse(compiledPrompt);
}
