import { randomBytes } from "node:crypto";
import { CodexRawPayload } from "./normalization";
import {
  clientTurnMetadataFromBody,
  extractCodexTurnIdentityFromBody,
  type CodexTurnIdentity,
} from "../../responses/turn-identity";

export {
  clientTurnMetadataFromBody,
  extractCodexTurnIdentityFromBody,
  type CodexTurnIdentity,
};

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
