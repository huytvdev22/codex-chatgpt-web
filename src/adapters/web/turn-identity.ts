import { randomBytes } from "node:crypto";
import { CodexRawPayload } from "./normalization";

export interface CodexTurnIdentity {
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

export function extractCodexTurnIdentityFromBody(value: unknown): CodexTurnIdentity {
  const metadata = clientTurnMetadataFromBody(value);
  const rawBody = (value && typeof value === "object" && !Array.isArray(value))
    ? (value as Record<string, unknown>)
    : {};

  // Trích xuất Thread ID theo đúng thứ tự ưu tiên hiện hữu.
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

/**
 * Resolves the conversation thread shared by Web adapters using the existing
 * precedence contract: raw Codex metadata, explicit conversation header, then
 * the broader turn-identity fallbacks such as session_id and prompt_cache_key.
 */
export function resolveWebThreadId(
  rawBody: unknown,
  parsedFallback: unknown,
  headers: Headers,
): string | undefined {
  const payloadSource = rawBody || parsedFallback;
  const rawPayload = CodexRawPayload.from(payloadSource);
  return rawPayload.getThreadId()
    || headers.get("x-codex-conversation-key")
    || extractCodexTurnIdentityFromBody(payloadSource).threadId;
}

export interface ResolveWebTurnTraceIdOptions {
  headers: Headers;
  byteLength?: number;
  encoding?: "base64url" | "hex";
}

/**
 * Preserves a caller-supplied Codex trace identity when available and creates
 * a cryptographically random provider trace otherwise.
 */
export function resolveWebTurnTraceId(
  options: ResolveWebTurnTraceIdOptions,
): string {
  return options.headers.get("x-codex-trace-id")
    || randomBytes(options.byteLength ?? 12).toString(
      options.encoding ?? "base64url",
    );
}

export interface ActiveWebTurnRegistration {
  signal: AbortSignal;
  finish: () => void;
}

/**
 * Tracks active Web provider turns by traceId so control-plane endpoints
 * (/admin/cancel-turn, /admin/cancel-turns) can abort in-flight browser work.
 */
export class WebTurnCancellationRegistry {
  private readonly active = new Map<
    string,
    {
      abortController: AbortController;
      done: Promise<void>;
      finish: () => void;
    }
  >();

  register(
    traceId: string,
    externalSignal?: AbortSignal,
  ): ActiveWebTurnRegistration {
    const abortController = new AbortController();
    let cleanupExternalAbort: (() => void) | undefined;

    if (externalSignal) {
      if (externalSignal.aborted) {
        abortController.abort(externalSignal.reason);
      } else {
        const onExternalAbort = () => {
          abortController.abort(externalSignal.reason);
        };
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        cleanupExternalAbort = () => {
          externalSignal.removeEventListener("abort", onExternalAbort);
        };
      }
    }

    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => {
      resolveDone = resolve;
    });

    let finished = false;
    const entry = {
      abortController,
      done,
      finish: () => {
        if (finished) return;
        finished = true;
        cleanupExternalAbort?.();
        if (this.active.get(traceId) === entry) {
          this.active.delete(traceId);
        }
        resolveDone();
      },
    };

    const previous = this.active.get(traceId);
    if (previous) {
      previous.abortController.abort(
        new DOMException(`Superseded by newer turn for trace ${traceId}`, "AbortError"),
      );
      previous.finish();
    }

    this.active.set(traceId, entry);
    return {
      signal: abortController.signal,
      finish: entry.finish,
    };
  }

  activeCount(): number {
    return this.active.size;
  }

  cancelByTraceId(traceId: string, reason?: unknown): number {
    const entry = this.active.get(traceId);
    if (!entry) return 0;
    if (!entry.abortController.signal.aborted) {
      entry.abortController.abort(
        reason ?? new DOMException(`Browser turn ${traceId} cancelled`, "AbortError"),
      );
    }
    return 1;
  }

  async cancelAll(reason?: unknown): Promise<number> {
    const entries = [...this.active.values()];
    for (const entry of entries) {
      if (!entry.abortController.signal.aborted) {
        entry.abortController.abort(
          reason ?? new DOMException("Active turn cancelled", "AbortError"),
        );
      }
    }
    await Promise.all(entries.map(entry => entry.done));
    return entries.length;
  }
}

export const activeWebTurnRegistry = new WebTurnCancellationRegistry();
