export interface ChatGptTurnIdentity {
  threadId?: string;
  turnId?: string;
  parentThreadId?: string;
  agentName?: string;
  subagentKind?: string;
}

export function clientTurnMetadataFromBody(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;

  // Ưu tiên client_metadata từ Codex
  if (body.client_metadata && typeof body.client_metadata === "object" && !Array.isArray(body.client_metadata)) {
    return body.client_metadata as Record<string, unknown>;
  }

  // Fallback metadata thông thường
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) {
    return body.metadata as Record<string, unknown>;
  }

  return null;
}

export function extractCodexTurnIdentityFromBody(value: unknown): ChatGptTurnIdentity {
  const metadata = clientTurnMetadataFromBody(value);
  const rawBody = (value && typeof value === "object" && !Array.isArray(value))
    ? (value as Record<string, unknown>)
    : {};

  // 1. Trích xuất Thread ID theo thứ tự ưu tiên
  let threadId: string | undefined;

  if (typeof metadata?.thread_id === "string" && metadata.thread_id.trim()) {
    threadId = metadata.thread_id.trim();
  } else if (typeof metadata?.session_id === "string" && metadata.session_id.trim()) {
    threadId = metadata.session_id.trim();
  } else if (typeof rawBody.prompt_cache_key === "string" && rawBody.prompt_cache_key.trim()) {
    threadId = rawBody.prompt_cache_key.trim();
  } else if (metadata?.["x-codex-turn-metadata"]) {
    try {
      const turnMeta = typeof metadata["x-codex-turn-metadata"] === "string"
        ? JSON.parse(metadata["x-codex-turn-metadata"])
        : metadata["x-codex-turn-metadata"];
      if (typeof turnMeta?.thread_id === "string" && turnMeta.thread_id.trim()) {
        threadId = turnMeta.thread_id.trim();
      } else if (typeof turnMeta?.session_id === "string" && turnMeta.session_id.trim()) {
        threadId = turnMeta.session_id.trim();
      }
    } catch {}
  }

  // 2. Trích xuất Turn ID
  let turnId: string | undefined;
  if (typeof metadata?.turn_id === "string" && metadata.turn_id.trim()) {
    turnId = metadata.turn_id.trim();
  } else if (metadata?.["x-codex-turn-metadata"]) {
    try {
      const turnMeta = typeof metadata["x-codex-turn-metadata"] === "string"
        ? JSON.parse(metadata["x-codex-turn-metadata"])
        : metadata["x-codex-turn-metadata"];
      if (typeof turnMeta?.turn_id === "string" && turnMeta.turn_id.trim()) {
        turnId = turnMeta.turn_id.trim();
      }
    } catch {}
  }

  return {
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(typeof metadata?.parent_thread_id === "string" ? { parentThreadId: metadata.parent_thread_id } : {}),
    ...(typeof metadata?.agent_name === "string" ? { agentName: metadata.agent_name } : {}),
    ...(typeof metadata?.subagent_kind === "string" ? { subagentKind: metadata.subagent_kind } : {}),
  };
}
