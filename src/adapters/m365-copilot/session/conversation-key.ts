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
 * Sinh mã định danh cuộc trò chuyện hỗn hợp (Composite Conversation Key) duy nhất:
 * [Tên Project + Hash Thư mục]__[Thread ID / Session Token]
 *
 * Đảm bảo:
 * 1. Hai project khác nhau trong VS Code sẽ có 2 key hoàn toàn khác nhau -> mở 2 Tab M365 riêng biệt.
 * 2. Khi người dùng bấm New Chat trong cùng project -> sinh ra session token mới -> mở Tab M365 mới.
 * 3. Các request tiếp theo trong cùng cuộc trò chuyện -> giữ nguyên key -> tái sử dụng đúng Tab M365 đó.
 */
export function resolveM365ConversationKey(options: {
  parsed: CodexParsedRequest;
  rawPayload: CodexRawPayload;
  headers?: Headers;
  hasPriorAssistantReply: boolean;
}): string {
  logFunctionInput("session:conversation-key", "resolveM365ConversationKey");

  // 1. Nếu caller gửi header x-codex-conversation-key chỉ định tường minh, ưu tiên dùng
  const explicitKey = options.headers?.get("x-codex-conversation-key")?.trim();
  if (explicitKey) {
    return explicitKey;
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
    return `${projectTag}__${rawThreadId}`;
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
    return `${projectTag}__${newSessionToken}`;
  }

  const existingSessionToken = activeProjectSessions.get(projectTag)!;
  return `${projectTag}__${existingSessionToken}`;
}

/**
 * Xóa session đã lưu của một project khi cuộc hội thoại kết thúc hoặc người dùng reset.
 */
export function clearProjectSession(projectTag: string): void {
  activeProjectSessions.delete(projectTag);
}
