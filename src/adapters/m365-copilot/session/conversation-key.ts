import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { CodexParsedRequest } from "../../../types";
import type { CodexRawPayload } from "../normalization/codex-raw-payload";
import { logFunctionInput } from "../debug-logger";

/**
 * Trích xuất đường dẫn thư mục làm việc (CWD / Workspace Root) của project từ request của Codex.
 * Codex IDE luôn chèn khối XML `<cwd>...</cwd>` vào systemPrompt hoặc tin nhắn người dùng.
 */
export function extractCodexProjectCwd(
  parsed: CodexParsedRequest,
  rawPayload?: CodexRawPayload,
  headers?: Headers
): string | undefined {
  logFunctionInput("session:conversation-key", "extractCodexProjectCwd");

  // 1. Kiểm tra từ header HTTP tùy biến (nếu caller có truyền)
  const headerCwd = headers?.get("x-codex-cwd") || headers?.get("x-codex-workspace");
  if (headerCwd && headerCwd.trim()) {
    return headerCwd.trim();
  }

  // 2. Trích xuất từ systemPrompt của Codex
  for (const sp of parsed.context.systemPrompt || []) {
    const match = sp.match(/<cwd>([^<]+)<\/cwd>/i);
    if (match && match[1]?.trim()) {
      return match[1].trim();
    }
    const rootMatch = sp.match(/<root>([^<]+)<\/root>/i);
    if (rootMatch && rootMatch[1]?.trim()) {
      return rootMatch[1].trim();
    }
  }

  // 3. Trích xuất từ nội dung tin nhắn context
  for (const msg of parsed.context.messages || []) {
    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(c => (c as any).text || "").join(" ")
        : "";
    const match = text.match(/<cwd>([^<]+)<\/cwd>/i);
    if (match && match[1]?.trim()) {
      return match[1].trim();
    }
    const rootMatch = text.match(/<root>([^<]+)<\/root>/i);
    if (rootMatch && rootMatch[1]?.trim()) {
      return rootMatch[1].trim();
    }
  }

  // 4. Trích xuất từ client_metadata của raw payload
  if (rawPayload?.client_metadata) {
    const workspaces = (rawPayload.client_metadata as any).workspaces;
    if (workspaces && typeof workspaces === "object") {
      const keys = Object.keys(workspaces);
      if (keys.length > 0 && keys[0]?.trim()) {
        return keys[0].trim();
      }
    }

    const turnMeta = rawPayload.client_metadata["x-codex-turn-metadata"];
    if (turnMeta) {
      try {
        const parsedMeta = typeof turnMeta === "string" ? JSON.parse(turnMeta) : turnMeta;
        if (parsedMeta?.cwd && typeof parsedMeta.cwd === "string") {
          return parsedMeta.cwd.trim();
        }
      } catch {}
    }
  }

  return undefined;
}

/**
 * Bảng lưu trữ phiên trò chuyện hiện tại của từng project (In-memory Project Session Registry).
 * Định dạng: projectIdentifier -> activeSessionToken
 */
const activeProjectSessions = new Map<string, string>();

/**
 * Trích xuất tên hiển thị ngắn gọn của Project (ví dụ: test-codex-todo-app) để hiển thị trên nhãn Tab của Launcher.
 */
export function extractProjectLabel(
  parsed: CodexParsedRequest,
  rawPayload?: CodexRawPayload,
  headers?: Headers
): string | undefined {
  const cwd = extractCodexProjectCwd(parsed, rawPayload, headers);
  if (!cwd) return undefined;
  const normalized = cwd.replace(/\\/g, "/");
  const name = basename(normalized).replace(/[^a-zA-Z0-9_-]/g, "_");
  return name || undefined;
}

/**
 * Sinh mã định danh cuộc trò chuyện hỗn hợp (Composite Conversation Key) duy nhất
 * được băm chuẩn SHA-256 (64 ký tự hex) để tương thích 100% với regex của Desktop Launcher:
 * SHA256([Tên Project + Hash Thư mục]__[Thread ID / Session Token])
 *
 * Đảm bảo:
 * 1. Hai project khác nhau trong VS Code sẽ có 2 hash hoàn toàn khác nhau -> Launcher mở 2 Tab M365 riêng biệt.
 * 2. Khi người dùng bấm New Chat trong cùng project -> sinh ra session token mới -> Launcher mở Tab M365 mới.
 * 3. Các request tiếp theo trong cùng cuộc trò chuyện -> giữ nguyên hash -> Launcher tái sử dụng đúng Tab M365 đó.
 * 4. Luôn khớp chính xác regex `^[a-f0-9]{64}$` của Desktop Launcher control server.
 */
export function resolveM365ConversationKey(options: {
  parsed: CodexParsedRequest;
  rawPayload: CodexRawPayload;
  headers?: Headers;
  hasPriorAssistantReply: boolean;
}): string {
  logFunctionInput("session:conversation-key", "resolveM365ConversationKey");

  // Helper băm chuỗi thành 64 ký tự hex SHA-256
  const toSha256 = (val: string) => {
    return /^[a-f0-9]{64}$/.test(val)
      ? val
      : createHash("sha256").update(val).digest("hex");
  };

  // 1. Nếu caller gửi header x-codex-conversation-key chỉ định tường minh, ưu tiên dùng
  const explicitKey = options.headers?.get("x-codex-conversation-key")?.trim();
  if (explicitKey) {
    return toSha256(explicitKey);
  }

  // 2. Xác định danh tính project từ đường dẫn CWD
  const cwd = extractCodexProjectCwd(options.parsed, options.rawPayload, options.headers);
  let projectTag = "default";
  if (cwd) {
    const folderName = basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "_") || "workspace";
    const cwdHash = createHash("md5").update(cwd).digest("hex").slice(0, 6);
    projectTag = `${folderName}_${cwdHash}`;
  }

  // 3. Xác định Thread ID
  const rawThreadId = options.rawPayload.getThreadId() || options.headers?.get("x-codex-thread-id")?.trim();
  if (rawThreadId) {
    activeProjectSessions.set(projectTag, rawThreadId);
    return toSha256(`${projectTag}__${rawThreadId}`);
  }

  // 4. Nếu client không truyền thread_id:
  // - Nếu chưa từng có phản hồi assistant (vừa bấm New Chat hoặc lần đầu gửi prompt):
  //   Sinh một session token mới cho project đó -> kích hoạt mở Tab M365 mới trên Launcher.
  // - Nếu đã có phản hồi assistant (các turn tiếp theo của cùng đoạn chat):
  //   Tái sử dụng session token đang có của project đó -> duy trì phiên tại Tab M365 hiện tại.
  if (!options.hasPriorAssistantReply || !activeProjectSessions.has(projectTag)) {
    const newSessionToken = `turn_${randomBytes(4).toString("hex")}`;
    activeProjectSessions.set(projectTag, newSessionToken);
    console.log(`[session:conversation-key] Bắt đầu đoạn chat mới cho project [${projectTag}]: session=${newSessionToken}`);
    return toSha256(`${projectTag}__${newSessionToken}`);
  }

  const existingSessionToken = activeProjectSessions.get(projectTag)!;
  return toSha256(`${projectTag}__${existingSessionToken}`);
}

/**
 * Xóa session đã lưu của một project khi cuộc hội thoại kết thúc hoặc người dùng reset.
 */
export function clearProjectSession(projectTag?: string): void {
  if (projectTag) {
    activeProjectSessions.delete(projectTag);
  } else {
    activeProjectSessions.clear();
  }
}

/**
 * Kiểm tra toàn diện xem cuộc hội thoại đã từng có phản hồi của trợ lý hoặc tool execution hay chưa.
 * Hỗ trợ cả hai định dạng:
 * 1. CodexParsedRequest.context.messages (OpenAI Chat Completion format)
 * 2. CodexRawPayload.input (OpenAI Responses API wire format)
 */
export function checkHasPriorAssistantReply(
  parsed: CodexParsedRequest,
  rawPayload?: CodexRawPayload
): boolean {
  logFunctionInput("session:conversation-key", "checkHasPriorAssistantReply");

  // 1. Kiểm tra trong parsed.context.messages
  const messages = parsed.context?.messages || [];
  if (messages.some(m => m.role === "assistant" || m.role === "toolResult")) {
    return true;
  }

  // 2. Kiểm tra trong rawPayload.input (Wire format)
  if (rawPayload && Array.isArray(rawPayload.input)) {
    for (const item of rawPayload.input) {
      if (!item) continue;
      if (
        item.role === "assistant" ||
        item.type === "function_call" ||
        item.type === "custom_tool_call" ||
        item.type === "function_call_output" ||
        item.type === "custom_tool_call_output"
      ) {
        return true;
      }
    }
  }

  return false;
}

