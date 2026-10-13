import type { CodexParsedRequest } from "../../../../types";
import { CodexRawPayload } from "../../normalization/core/codex-raw-payload";
import { CodexPayloadNormalizer } from "../../normalization/core/codex-normalizer";

export class PlanModeDetector {
  /**
   * Kiểm tra xem người dùng có vừa bấm xác nhận triển khai kế hoạch hay không
   */
  static isImplementingPlanRequest(parsed?: CodexParsedRequest): boolean {
    const messages = parsed?.context?.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map(c => (c.type === "text" ? c.text : "")).join(" ")
            : "";
        if (/PLEASE IMPLEMENT THIS PLAN/i.test(text) || /Yes, implement this plan/i.test(text)) {
          return true;
        }
        break;
      }
    }
    return false;
  }

  /**
   * Kiểm tra xem yêu cầu hiện tại có đang ở chế độ Plan Mode (/plan) hay không.
   */
  static isPlanModeRequest(parsed: CodexParsedRequest): boolean {
    if (this.isImplementingPlanRequest(parsed)) {
      return false;
    }
    const payload = CodexRawPayload.from(parsed._rawBody || parsed);
    return CodexPayloadNormalizer.detectCollaborationMode(payload) === "plan";
  }
}
