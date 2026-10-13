import type { CodexParsedRequest } from "../../../../types";
import type { TitleGuardOptions } from "../dto/title-guard-options.dto";
import type { ITitleGuard } from "../contracts/title-guard.interface";

/**
 * Bộ bảo vệ ngắt nhanh lượt sinh tiêu đề (Title Guard).
 * Đánh chặn các request sinh tiêu đề cuộc hội thoại ngầm từ Codex IDE
 * và phản hồi ngay lập tức trong 5ms mà không cần gọi đến browser.
 */
export class BaseTitleGuard implements ITitleGuard {
  protected readonly options: TitleGuardOptions;

  constructor(options?: TitleGuardOptions) {
    this.options = {
      enableTitleGuard: options?.enableTitleGuard,
      defaultSubject: options?.defaultSubject ?? "Coding Session",
      defaultProviderName: options?.defaultProviderName ?? "M365",
      defaultDescription: options?.defaultDescription ?? "Phiên lập trình với M365 Copilot",
      envFlagNames: options?.envFlagNames ?? [
        "M365_ENABLE_TITLE_GUARD",
        "CODEX_M365_ENABLE_TITLE_GUARD",
        "ENABLE_TITLE_GUARD",
      ],
    };
  }

  public isEnabled(customFlagOrOptions?: boolean | { enableTitleGuard?: boolean }): boolean {
    const customFlag = typeof customFlagOrOptions === "object"
      ? customFlagOrOptions?.enableTitleGuard
      : customFlagOrOptions;
    if (typeof customFlag === "boolean") return customFlag;
    if (typeof this.options.enableTitleGuard === "boolean") return this.options.enableTitleGuard;

    for (const envKey of this.options.envFlagNames || []) {
      const val = process.env[envKey];
      if (val === "true" || val === "1") return true;
    }
    return false;
  }

  public isTitleRequest(
    parsed: CodexParsedRequest,
    _compiledPrompt: string,
    customFlagOrOptions?: boolean | { enableTitleGuard?: boolean }
  ): boolean {
    if (!this.isEnabled(customFlagOrOptions)) {
      return false;
    }

    const anyParsed = parsed as any;
    if (
      (anyParsed.context?.toolResults && anyParsed.context.toolResults.length > 0) ||
      (parsed.context?.messages &&
        parsed.context.messages.some(
          (m: any) => m.role === "toolResult" || (m as any).role === "tool"
        )) ||
      (anyParsed.input &&
        Array.isArray(anyParsed.input) &&
        anyParsed.input.some(
          (item: any) => item.role === "tool" || item.type === "tool_result"
        ))
    ) {
      return false;
    }

    const allMessages: any[] = parsed.context?.messages || anyParsed.messages || [];
    const userMessages = allMessages.filter((m: any) => m.role === "user");
    const lastUserMsgObj = userMessages.length > 0 ? userMessages[userMessages.length - 1] : undefined;
    const lastUserMsg = typeof lastUserMsgObj?.content === "string"
      ? lastUserMsgObj.content.toLowerCase()
      : Array.isArray(lastUserMsgObj?.content)
        ? lastUserMsgObj.content.map((c: any) => (typeof c === "string" ? c : c?.text || "")).join(" ").toLowerCase()
        : "";

    const devMessages = allMessages.filter((m: any) => m.role === "developer" || m.role === "system");
    const lastDevMsgObj = devMessages.length > 0 ? devMessages[devMessages.length - 1] : undefined;
    const lastDevMsg = typeof lastDevMsgObj?.content === "string"
      ? lastDevMsgObj.content.toLowerCase()
      : Array.isArray(lastDevMsgObj?.content)
        ? lastDevMsgObj.content.map((c: any) => (typeof c === "string" ? c : c?.text || "")).join(" ").toLowerCase()
        : "";

    const systemPrompts = (parsed.context?.systemPrompt || []).map((s: any) => String(s).toLowerCase()).join(" ");
    const specificText = `${lastUserMsg} ${lastDevMsg} ${systemPrompts}`.trim();
    if (!specificText) return false;

    const isExplicitTitle =
      specificText.includes("generate a title") ||
      specificText.includes("generate a concise title") ||
      specificText.includes("short title for the conversation") ||
      specificText.includes("title for this session") ||
      specificText.includes("session title") ||
      specificText.includes("brief title") ||
      (specificText.includes("title:") && specificText.includes("description:") && specificText.length < 500);

    return Boolean(isExplicitTitle);
  }

  public generateTitleResponse(compiledPrompt: string): string {
    let subject = this.options.defaultSubject || "Coding Session";
    const match = compiledPrompt.match(
      /(?:xây dựng|tạo|viết|sửa|debug|tích hợp|hướng dẫn|hàm|file|module)\s+([^.,\n]+)/i
    );
    if (match && match[1]) {
      subject = match[1].trim().slice(0, 30);
    }

    const desc = this.options.defaultDescription || `Phiên lập trình với ${this.options.defaultProviderName}`;
    return `title: ${this.options.defaultProviderName} - ${subject}\ndescription: ${desc}`;
  }

  // Static helpers
  public static isTitleRequest(
    parsed: CodexParsedRequest,
    compiledPrompt: string,
    options?: { enableTitleGuard?: boolean }
  ): boolean {
    return new BaseTitleGuard().isTitleRequest(parsed, compiledPrompt, options?.enableTitleGuard);
  }

  public static isTitleGuardEnabled(customFlag?: boolean): boolean {
    return new BaseTitleGuard().isEnabled(customFlag);
  }

  public static generateTitleResponse(compiledPrompt: string, providerName = "Web Chat"): string {
    return new BaseTitleGuard({ defaultProviderName: providerName }).generateTitleResponse(compiledPrompt);
  }
}
