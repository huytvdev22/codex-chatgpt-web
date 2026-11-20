import type { TokenSourceKind } from "./types";

export interface UsageFooterFormatInput {
  modelId: string;
  stepsCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens?: number;
  tokenSource: TokenSourceKind;
  durationMs: number;
}

const FOOTER_TAIL_REGEX = /\r?\n{1,2}---\r?\n📊\s+`[^`\n]+`\s+·[^\n]*(?:tok|tokens)[^\n]*$/u;

function formatNumber(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  return `${Math.round(seconds)}s`;
}

/**
 * Định dạng dòng thống kê token gắn cuối `final_answer` và gỡ sạch khi đọc lại từ `priorHistory`.
 */
export class UsageFooterFormatter {
  public static formatFooter(input: UsageFooterFormatInput): string {
    const approxPrefix = input.tokenSource === "ai-studio-dom" ? "" : "~";
    const scopeLabel =
      input.stepsCount > 1
        ? `task (${input.stepsCount} bước)`
        : "lượt này";
    const deltaSign = input.tokenSource === "ai-studio-dom" ? "+" : approxPrefix;
    const contextPart =
      typeof input.contextTokens === "number" && input.contextTokens > 0
        ? ` · phiên: **${approxPrefix}${formatNumber(input.contextTokens)}** tok`
        : "";
    const durationPart = formatDuration(input.durationMs);

    return (
      `\n\n---\n` +
      `📊 \`${input.modelId}\` · ${scopeLabel}: **${deltaSign}${formatNumber(input.totalTokens)}** tok ` +
      `(in ${formatNumber(input.inputTokens)} / out ${formatNumber(input.outputTokens)})` +
      `${contextPart} · ${durationPart}`
    );
  }

  public static appendFooter(content: string, input: UsageFooterFormatInput): string {
    const trimmed = content.replace(/\s+$/, "");
    return `${trimmed}${this.formatFooter(input)}`;
  }

  public static stripFooter(content: string): string {
    if (!content || !content.includes("📊")) return content;
    return content.replace(FOOTER_TAIL_REGEX, "").replace(/\s+$/, "");
  }
}
