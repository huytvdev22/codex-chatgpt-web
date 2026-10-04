import type { CodexContentPart, CodexParsedRequest } from "../../types";
import { CodexRawPayload } from "./codex-raw-payload";
import {
  TOOL_DECLARATION_PROMPT,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  TOOL_REMINDER_PROMPT,
  TOOL_RESULT_HINTS,
  OUTPUT_FORMAT_HINTS,
} from "./prompts";

// Re-export để đảm bảo 100% tương thích ngược cho các module và tests đang import từ ./prompt
export {
  TOOL_DECLARATION_PROMPT,
  PLAN_MODE_PROMPT,
  IMPLEMENT_PLAN_PROMPT,
  TOOL_REMINDER_PROMPT,
  TOOL_RESULT_HINTS,
  OUTPUT_FORMAT_HINTS,
} from "./prompts";

const MAX_M365_PROMPT_CHARS = 95_000;
const MAX_TOOL_RESULT_CHARS = 8_000;

function stringifyContent(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part.type === "text") return part.text;
        if (part.type === "image") return `[Image: ${part.imageUrl.slice(0, 50)}...]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Cắt tỉa nội dung kết quả công cụ (Truncation Guard) để bảo vệ giao diện Web M365 Copilot
 * khỏi nguy cơ quá tải bộ đệm khi log hoặc file quá lớn.
 */
export function truncateToolResult(content: string, maxChars = MAX_TOOL_RESULT_CHARS): string {
  if (content.length <= maxChars) {
    return content;
  }
  const half = Math.floor((maxChars - 200) / 2);
  const head = content.slice(0, half);
  const tail = content.slice(-half);
  const omitted = content.length - (head.length + tail.length);
  return `${head}\n\n[... Đã lược bớt ${omitted} ký tự ở giữa để tối ưu kích thước phản hồi ...]\n\n${tail}`;
}

/**
 * Kiểm tra xem người dùng có vừa bấm xác nhận triển khai kế hoạch hay không
 * (Ví dụ: "PLEASE IMPLEMENT THIS PLAN", "Yes, implement this plan")
 */
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

/**
 * Kiểm tra xem yêu cầu hiện tại có đang ở chế độ Plan Mode (/plan) hay không.
 * Quan trọng: Chỉ dựa trên trạng thái hợp tác MỚI NHẤT (LATEST collaboration mode),
 * không được lấy trạng thái cũ trong lịch sử khi người dùng đã chuyển sang Default mode hoặc phê duyệt triển khai.
 */
export function isPlanModeRequest(parsed: CodexParsedRequest): boolean {
  // 1. Nếu đang là lượt phê duyệt triển khai kế hoạch -> chắc chắn không phải Plan mode
  if (isImplementingPlanRequest(parsed)) {
    return false;
  }

  // 2. Kiểm tra raw body nếu có collaboration_mode hoặc collaboration_mode_kind
  const raw = parsed._rawBody as Record<string, any> | undefined;
  if (raw) {
    if (raw.collaboration_mode_kind === "default" || raw.collaboration_mode?.mode === "default") {
      return false;
    }
    if (raw.collaboration_mode_kind === "plan" || raw.collaboration_mode?.mode === "plan") {
      return true;
    }
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

  // 3. Tìm khối <collaboration_mode> MỚI NHẤT (duyệt ngược từ tin nhắn cuối về đầu)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
      ? msg.content.map(c => (c.type === "text" ? c.text : "")).join(" ")
      : "";

    if (text.includes("<collaboration_mode") || text.includes("# Collaboration Mode")) {
      if (text.includes("Mode: Default") || text.includes('mode="default"') || text.includes("now in Default mode")) {
        return false;
      }
      if (text.includes("Mode: Plan") || text.includes("# Plan Mode") || text.includes('mode="plan"')) {
        return true;
      }
    }
  }

  // 4. Kiểm tra trong systemPrompt mới nhất
  for (const sp of parsed.context.systemPrompt || []) {
    if (sp.includes("<collaboration_mode") || sp.includes("# Collaboration Mode")) {
      if (sp.includes("Mode: Default") || sp.includes('mode="default"') || sp.includes("now in Default mode")) {
        return false;
      }
      if (sp.includes("Mode: Plan") || sp.includes("# Plan Mode") || sp.includes('mode="plan"')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Biên dịch CodexParsedRequest thành prompt tối ưu cho Microsoft 365 Copilot
 * @param isNewConversation true nếu là cuộc trò chuyện mới hoặc cần ngữ cảnh đầy đủ; false nếu đang tiếp tục cuộc trò chuyện hiện tại
 */
export function compileM365Prompt(parsed: CodexParsedRequest, isNewConversation = true): string {
  const parts: string[] = [];
  const isImplementingPlan = isImplementingPlanRequest(parsed);
  const isPlanMode = !isImplementingPlan && isPlanModeRequest(parsed);

  const allMessages = parsed.context.messages || [];
  let messages = allMessages;

  if (!isNewConversation) {
    const lastAssistantIdx = allMessages.findLastIndex(msg => msg.role === "assistant");
    if (lastAssistantIdx >= 0) {
      if (lastAssistantIdx < allMessages.length - 1) {
        messages = allMessages.slice(lastAssistantIdx + 1);
      } else {
        // Nếu tin nhắn cuối cùng chính là của assistant (không có input mới từ user hay tool)
        // Tuyệt đối không gửi lại assistant message để tránh model hiểu nhầm là cần tiếp tục
        messages = [];
      }
    }
  }

  // 1. Thu thập Developer & System Prompts và Tool Instructions
  if (isNewConversation && parsed.context.systemPrompt && parsed.context.systemPrompt.length > 0) {
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
      parts.push(`[System Instructions]:\n${filteredSystem}`);
    }
  }

  // Bổ sung chỉ dẫn chế độ Plan Mode hoặc Triển khai kế hoạch
  if (isPlanMode) {
    parts.push(PLAN_MODE_PROMPT);
  } else if (isImplementingPlan) {
    parts.push(IMPLEMENT_PLAN_PROMPT);
  }

  // Luôn inject định nghĩa tool hoặc lời nhắc thực thi công cụ
  const hasToolResultInTurn = messages.some(m => m.role === "toolResult");
  if (!hasToolResultInTurn) {
    parts.push(`[Tool Instructions]:\n${TOOL_DECLARATION_PROMPT}`);
  } else {
    // Khi có toolResult trong lượt hiện tại, vẫn nhắc lại cơ chế tool calling để Copilot không bao giờ "thoát vai" hay từ chối
    parts.push(`[Tool Instructions]:\n${TOOL_REMINDER_PROMPT}`);
  }

  // 2. Thu thập Messages theo thứ tự thời gian
  for (const msg of messages) {
    if (msg.role === "developer") {
      let text = stringifyContent(msg.content);
      text = text
        .replace(/<codex_apps_client_time_context>[\s\S]*?<\/codex_apps_client_time_context>/gi, "")
        .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/gi, "")
        .replace(/<codex_apps_open_page_instructions>[\s\S]*?<\/codex_apps_open_page_instructions>/gi, "")
        .trim();
      // Bỏ qua skills_instructions dài nếu > 2000 ký tự để bảo vệ token budget
      // Bỏ qua base instructions mặc định "You are Codex, a coding assistant..." vì đã có TOOL_DECLARATION_PROMPT chuyên dụng cho IDE
      if (
        text.length > 0 &&
        text.length < 2000 &&
        !text.includes("<skills_instructions>") &&
        !text.includes("You are Codex, a coding assistant")
      ) {
        parts.push(`[Context]: ${text}`);
      }
    } else if (msg.role === "user") {
      let text = stringifyContent(msg.content);
      text = text
        .replace(/<codex_apps_client_time_context>[\s\S]*?<\/codex_apps_client_time_context>/gi, "")
        .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/gi, "")
        .replace(/<codex_apps_open_page_instructions>[\s\S]*?<\/codex_apps_open_page_instructions>/gi, "")
        .trim();
      if (text) {
        parts.push(text);
      }
    } else if (msg.role === "assistant") {
      const texts: string[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          texts.push(part.text);
        }
      }
      if (texts.length > 0) {
        parts.push(`[Trợ lý]: ${texts.join("\n")}`);
      }
    } else if (msg.role === "toolResult") {
      const text = stringifyContent(msg.content);
      if (text) {
        console.log("[M365 TOOL] received tool result");
        const safeText = truncateToolResult(text);
        if (isPlanMode) {
          parts.push(`<tool_result>\n${safeText}\n</tool_result>\n${TOOL_RESULT_HINTS.planMode}`);
        } else if (isImplementingPlan) {
          parts.push(`<tool_result>\n${safeText}\n</tool_result>\n${TOOL_RESULT_HINTS.implementPlan}`);
        } else {
          parts.push(`<tool_result>\n${safeText}\n</tool_result>\n${TOOL_RESULT_HINTS.default}`);
        }
      }
    }
  }

  // Nếu lượt này là yêu cầu của người dùng (không phải nhận toolResult),
  // bổ sung chỉ dẫn định dạng ở cuối để định hướng mô hình
  if (!hasToolResultInTurn && parts.length > 0) {
    if (isPlanMode) {
      parts.push(OUTPUT_FORMAT_HINTS.planMode);
    } else if (isImplementingPlan) {
      parts.push(OUTPUT_FORMAT_HINTS.implementPlan);
    } else {
      parts.push(OUTPUT_FORMAT_HINTS.default);
    }
  }

  let finalPrompt = parts.join("\n\n").trim();

  // 3. Cắt tỉa nếu vượt quá ngưỡng an toàn của M365 (95,000 ký tự)
  if (finalPrompt.length > MAX_M365_PROMPT_CHARS) {
    // Giữ lại phần đầu (hướng dẫn) và phần đuôi (câu hỏi/ngữ cảnh gần nhất)
    const headLimit = 15_000;
    const tailLimit = MAX_M365_PROMPT_CHARS - headLimit - 200;
    const head = finalPrompt.slice(0, headLimit);
    const tail = finalPrompt.slice(-tailLimit);
    finalPrompt = `${head}\n\n... [Một số ngữ cảnh cũ được rút gọn để tối ưu độ dài cho M365 Copilot] ...\n\n${tail}`;
  }

  return finalPrompt;
}

export { compileM365HybridForwardPrompt } from "./temp-chat";


