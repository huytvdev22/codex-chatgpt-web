import type { CodexContentPart, CodexParsedRequest } from "../../../types";
import { CodexRawPayload } from "../codex-raw-payload";
import { CodexPayloadNormalizer } from "../codex-normalizer";
import {
  TOOL_DECLARATION_PROMPT,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
} from "../prompts";
import { MANDATORY_4_BACKTICK_MARKDOWN_PROMPT } from "./prompts";

const MAX_M365_PROMPT_CHARS = 95_000;
const MAX_TOOL_RESULT_CHARS = 8_000;

export function truncateToolResult(content: string, maxChars = MAX_TOOL_RESULT_CHARS): string {
  if (content.length <= maxChars) return content;
  const half = Math.floor((maxChars - 200) / 2);
  const head = content.slice(0, half);
  const tail = content.slice(-half);
  const omitted = content.length - (head.length + tail.length);
  return `${head}\n\n[... Đã lược bớt ${omitted} ký tự ở giữa để tối ưu kích thước phản hồi ...]\n\n${tail}`;
}

export function isImplementingPlanRequest(parsed: CodexParsedRequest): boolean {
  const messages = parsed.context.messages || [];
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

export function isPlanModeRequest(parsed: CodexParsedRequest): boolean {
  if (isImplementingPlanRequest(parsed)) return false;
  const raw = parsed._rawBody as Record<string, any> | undefined;
  if (raw) {
    if (raw.collaboration_mode_kind === "default" || raw.collaboration_mode?.mode === "default") return false;
    if (raw.collaboration_mode_kind === "plan" || raw.collaboration_mode?.mode === "plan") return true;
    if (raw.client_metadata) {
      const cm = raw.client_metadata;
      if (cm.collaboration_mode?.mode === "default" || cm.collaboration_mode_kind === "default") return false;
      if (cm.collaboration_mode?.mode === "plan" || cm.collaboration_mode_kind === "plan") return true;
      if (typeof cm["x-codex-turn-metadata"] === "string") {
        try {
          const tm = JSON.parse(cm["x-codex-turn-metadata"]);
          if (tm.collaboration_mode?.mode === "default" || tm.collaboration_mode_kind === "default") return false;
          if (tm.collaboration_mode?.mode === "plan" || tm.collaboration_mode_kind === "plan") return true;
        } catch {}
      }
    }
  }
  const messages = parsed.context.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
      ? msg.content.map(c => (c.type === "text" ? c.text : "")).join(" ")
      : "";
    if (text.includes("<collaboration_mode") || text.includes("# Collaboration Mode")) {
      if (text.includes("Mode: Default") || text.includes('mode="default"') || text.includes("now in Default mode")) return false;
      if (text.includes("Mode: Plan") || text.includes("# Plan Mode") || text.includes('mode="plan"')) return true;
    }
  }
  for (const sp of parsed.context.systemPrompt || []) {
    if (sp.includes("<collaboration_mode") || sp.includes("# Collaboration Mode")) {
      if (sp.includes("Mode: Default") || sp.includes('mode="default"') || sp.includes("now in Default mode")) return false;
      if (sp.includes("Mode: Plan") || sp.includes("# Plan Mode") || sp.includes('mode="plan"')) return true;
    }
  }
  return false;
}

/**
 * Xây dựng Prompt chuyển tiếp cho chế độ Temporary Chat Per Request.
 * Sử dụng CodexPayloadNormalizer để trích xuất canonical request,
 * và tiêm chỉ thị MANDATORY_4_BACKTICK_MARKDOWN_PROMPT ở cuối prompt.
 */
export function compileM365HybridForwardPrompt(parsed: CodexParsedRequest, rawBody?: unknown): string {
  const payload = CodexRawPayload.from(rawBody || parsed._rawBody || parsed);
  const normalized = CodexPayloadNormalizer.normalize(payload);

  const sections: string[] = [];

  // 1. System Protocol & Tool Instructions
  sections.push(TOOL_DECLARATION_PROMPT);

  // 2. Chỉ dẫn Plan Mode hoặc Triển khai kế hoạch nếu có
  const isImplementingPlan = isImplementingPlanRequest(parsed);
  const isPlanMode = !isImplementingPlan && isPlanModeRequest(parsed);
  if (isPlanMode) {
    sections.push(PLAN_MODE_PROMPT);
  } else if (isImplementingPlan) {
    sections.push(IMPLEMENT_PLAN_PROMPT);
  }

  // 3. System Instructions từ Codex IDE
  if (parsed.context?.systemPrompt && parsed.context.systemPrompt.length > 0) {
    const filteredSystem = parsed.context.systemPrompt
      .map(sp => sp.trim())
      .filter(
        sp =>
          sp.length > 0 &&
          !sp.startsWith("<environment_context>") &&
          !sp.includes("spawn_agent") &&
          !sp.includes("You are Codex, a coding assistant")
      )
      .join("\n\n");
    if (filteredSystem) {
      sections.push(`[System Instructions]:\n${filteredSystem}`);
    }
  }

  // 4. Ngữ cảnh Môi trường làm việc (Environment Context)
  if (normalized.environmentContext) {
    sections.push(`[NGỮ CẢNH DỰ ÁN & MÔI TRƯỜNG]:\n${normalized.environmentContext}`);
  }

  // 5. Chỉ thị của Dự án / Developer Rules
  if (normalized.developerInstructions && normalized.developerInstructions.length > 0) {
    const devRules = normalized.developerInstructions.map(r => `- ${r}`).join("\n");
    sections.push(`[CHỈ THỊ CỦA DỰ ÁN / DEVELOPER RULES]:\n${devRules}`);
  }

  // 6. Danh sách công cụ khả dụng trong IDE
  if (normalized.activeCodingTools.length > 0) {
    const toolList = normalized.activeCodingTools
      .map(t => `- ${t.identity.name}: ${t.description.split("\n")[0] || ""}`)
      .join("\n");
    sections.push(`[CÁC CÔNG CỤ CÓ SẴN TRONG IDE]:\n${toolList}`);
  }

  // 7. Lịch sử trao đổi đầy đủ (Bảo toàn ngữ cảnh các lượt trước)
  if (normalized.priorHistory.length > 0) {
    const historyLines: string[] = [];
    for (const h of normalized.priorHistory) {
      if (h.role === "user") {
        historyLines.push(`Người dùng: ${h.content}`);
      } else if (h.role === "assistant") {
        historyLines.push(`Trợ lý: ${h.content}`);
      } else if (h.role === "tool") {
        historyLines.push(`<tool_result id="${h.callId || ""}">\n${truncateToolResult(h.content)}\n</tool_result>`);
      }
    }
    if (historyLines.length > 0) {
      sections.push(`[LỊCH SỬ TRAO ĐỔI]:\n${historyLines.join("\n\n")}`);
    }
  }

  // 8. Kết quả Tool gần nhất (Trailing tool results của turn hiện tại)
  if (normalized.trailingToolResults.length > 0) {
    const resultBlocks = normalized.trailingToolResults.map(res =>
      `<tool_result id="${res.callId}">\n${truncateToolResult(res.output)}\n</tool_result>`
    );
    sections.push(
      `[KẾT QUẢ THỰC THI CÔNG CỤ VỪA NHẬN ĐƯỢC TỪ IDE]:\n${resultBlocks.join("\n\n")}\n\nHãy phân tích kết quả trên. Nếu cần thực hiện bước kế tiếp, hãy xuất khối công cụ tương ứng. Nếu đã hoàn thành nhiệm vụ, hãy trả lời kết luận cho người dùng.`
    );
  }

  // 9. Yêu cầu của người dùng mới nhất (Latest user instruction duy nhất)
  if (normalized.latestUserInstruction) {
    sections.push(`[YÊU CẦU CỦA NGƯỜI DÙNG]:\n${normalized.latestUserInstruction}`);
  }

  // 10. ĐỊNH HƯỚNG FAST-PATH 4-BACKTICKS (Tận dụng Recency Bias ở cuối cùng)
  sections.push(MANDATORY_4_BACKTICK_MARKDOWN_PROMPT);

  let finalPrompt = sections.join("\n\n").trim();

  // 11. Cắt tỉa an toàn độ dài (Budgeting Guard) nếu vượt quá ngưỡng an toàn của M365 (95,000 ký tự)
  if (finalPrompt.length > MAX_M365_PROMPT_CHARS) {
    const headLimit = 25_000;
    const tailLimit = MAX_M365_PROMPT_CHARS - headLimit - 200;
    const head = finalPrompt.slice(0, headLimit);
    const tail = finalPrompt.slice(-tailLimit);
    finalPrompt = `${head}\n\n... [Một số ngữ cảnh cũ được rút gọn để tối ưu độ dài cho M365 Copilot] ...\n\n${tail}`;
  }

  return finalPrompt;
}
