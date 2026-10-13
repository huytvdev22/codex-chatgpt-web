import {
  FormatRetryBuilder,
  type FormatRetryOptions,
} from "../../base-web/prompts";

export type M365FormatRetryOptions = FormatRetryOptions;

/** Tạo follow-up yêu cầu M365 phát lại cùng nội dung, tuyệt đối không tiếp tục tác vụ. */
export function buildM365FormatRetryPrompt(options: M365FormatRetryOptions): string {
  return FormatRetryBuilder.buildFormatRetryPrompt(options);
}
