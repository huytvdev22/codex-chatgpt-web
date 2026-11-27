import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

export type ResponseStateScope = "codex" | "assistant";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** In-memory high-water byte cap across all entries. Forced store:false continuation chains
 * store the full expanded input each turn — ~quadratic bytes per chain —
 * so a count cap alone cannot bound memory. Oldest-first eviction applies past this mark. */
const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_SCOPE_RESPONSE_BYTES: Record<ResponseStateScope, number> = {
  codex: 40 * 1024 * 1024,
  assistant: 24 * 1024 * 1024,
};
/** Entries whose serialized size exceeds this are kept in memory but skipped on disk: inputs can
 * carry base64 `input_image` data URLs, and one screenshot-heavy thread must not balloon the file. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;

export interface StoredResponseState {
  createdAt: number;
  items: unknown[];
  /** Approximate in-memory size, computed locally at insert time (never trusted from disk). */
  sizeBytes?: number;
  schemaVersion?: number;
  scope?: ResponseStateScope;
}

const states = new Map<string, StoredResponseState>();
let storedResponseBytes = 0;
const storedScopeBytes: Record<ResponseStateScope, number> = {
  codex: 0,
  assistant: 0,
};

function normalizeScope(scope?: ResponseStateScope): ResponseStateScope {
  return scope === "assistant" ? "assistant" : "codex";
}

/** The ONLY size computation: approximate entry weight from its items payload. */
function measuredEntry(entry: Omit<StoredResponseState, "sizeBytes">): StoredResponseState {
  let sizeBytes = 0;
  try {
    sizeBytes = JSON.stringify(entry.items).length;
  } catch {
    /* unserializable items: weightless rather than fatal */
  }
  return {
    ...entry,
    scope: normalizeScope(entry.scope),
    sizeBytes,
  };
}

/** The ONLY insertion point: keeps the byte counter consistent on replacement. */
function setEntry(id: string, entry: Omit<StoredResponseState, "sizeBytes">): void {
  deleteEntry(id);
  const measured = measuredEntry(entry);
  const weight = measured.sizeBytes ?? 0;
  const scope = normalizeScope(measured.scope);
  storedResponseBytes += weight;
  storedScopeBytes[scope] += weight;
  states.set(id, measured);
}

/** The ONLY deletion point: TTL, count, byte, and explicit deletes all route here. */
function deleteEntry(id: string): void {
  const existing = states.get(id);
  if (!existing) return;
  const weight = existing.sizeBytes ?? 0;
  const scope = normalizeScope(existing.scope);
  storedResponseBytes -= weight;
  storedScopeBytes[scope] -= weight;
  if (storedResponseBytes < 0) storedResponseBytes = 0;
  if (storedScopeBytes[scope] < 0) storedScopeBytes[scope] = 0;
  states.delete(id);
}
// Expansion provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. Consumers use the prefix length to bind trusted history and rolling checkpoints to the
// exact replayed portion of this request.
const replayedInputPrefixLengths = new WeakMap<object, number>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;
let asyncPersistInFlight: Promise<void> | null = null;
let asyncWriteSeq = 0;

function now(): number {
  return Date.now();
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

/**
 * Best-effort disk snapshot so previous_response_id chains survive a proxy restart (the
 * dominant expansion-miss cause: an in-memory-only store dies with the process, and the next
 * chained turn then reaches the upstream as a naked delta). Load is lazy on first store access;
 * persistence is debounced + unref'd so the hot path never blocks and the process can exit.
 * Every disk failure is swallowed — the snapshot is a cache, not a source of truth.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const path = snapshotPath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.states)) return;
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, state] = entry as [unknown, unknown];
      if (typeof id !== "string" || !state || typeof state !== "object") continue;
      const rec = state as StoredResponseState;
      if (typeof rec.createdAt !== "number" || !Array.isArray(rec.items)) continue;
      // Recompute sizes locally while loading; persisted sizeBytes is never trusted.
      setEntry(id, {
        createdAt: rec.createdAt,
        items: rec.items,
        schemaVersion: typeof rec.schemaVersion === "number" ? rec.schemaVersion : undefined,
        scope: rec.scope === "assistant" ? "assistant" : "codex",
      });
    }
    pruneResponses();
  } catch {
    /* missing/corrupt snapshot: start empty */
  }
}

function serializeSnapshot(): string {
  const entries: [string, StoredResponseState][] = [];
  let total = 0;
  // Newest-first so the most recent chains survive both caps.
  for (const entry of [...states].reverse()) {
    // sizeBytes is in-memory accounting only; keep it out of the disk snapshot.
    const [id, state] = entry;
    const { sizeBytes: _sizeBytes, ...persistable } = state;
    const persistEntry: [string, StoredResponseState] = [id, persistable];
    const size = JSON.stringify(persistEntry).length;
    if (size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
    if (total + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
    total += size;
    entries.push(persistEntry);
  }
  entries.reverse();
  return JSON.stringify({ version: 1, states: entries });
}

function persistNow(path: string): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  try {
    const payload = serializeSnapshot();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdirSync's mode only applies on creation — re-harden an existing config dir so the
    // conversation-content snapshot never lands in a group/world-readable directory.
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
    atomicWriteFile(path, payload);
  } catch {
    /* best-effort: disk trouble must never affect request handling */
  }
}

async function persistAsync(path: string): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  const runWrite = async () => {
    const tmpPath = `${path}.tmp-${process.pid}-${++asyncWriteSeq}`;
    try {
      const payload = serializeSnapshot();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try { await chmod(dirname(path), 0o700); } catch { /* best-effort */ }
      await writeFile(tmpPath, payload, { encoding: "utf-8", mode: 0o600 });
      await rename(tmpPath, path);
    } catch {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  };
  const next = asyncPersistInFlight
    ? asyncPersistInFlight.then(runWrite, runWrite)
    : runWrite();
  asyncPersistInFlight = next;
  try {
    await next;
  } finally {
    if (asyncPersistInFlight === next) {
      asyncPersistInFlight = null;
    }
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  // Resolve the target path now: tests may swap CODEX_CHATGPT_WEB_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  pendingPersistPath = snapshotPath();
  const path = pendingPersistPath;
  persistTimer = setTimeout(() => {
    void persistAsync(path);
  }, SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export function flushResponseState(): void {
  if (!persistTimer) return;
  // Use the path captured when the write was scheduled; CODEX_CHATGPT_WEB_HOME may have moved.
  persistNow(pendingPersistPath ?? snapshotPath());
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function evictOldestInScope(scope: ResponseStateScope, budgetBytes: number): void {
  for (const [id, state] of states) {
    if (storedScopeBytes[scope] <= budgetBytes) break;
    if (normalizeScope(state.scope) !== scope) continue;
    deleteEntry(id);
  }
}

export function pruneResponses(
  at = now(),
  scopeBudgets: Partial<Record<ResponseStateScope, number>> = {},
): void {
  for (const [id, state] of states) {
    if (at - state.createdAt > RESPONSE_TTL_MS) deleteEntry(id);
  }
  const codexBudget = scopeBudgets.codex ?? MAX_SCOPE_RESPONSE_BYTES.codex;
  const assistantBudget = scopeBudgets.assistant ?? MAX_SCOPE_RESPONSE_BYTES.assistant;
  if (storedScopeBytes.codex > codexBudget) {
    evictOldestInScope("codex", codexBudget);
  }
  if (storedScopeBytes.assistant > assistantBudget) {
    evictOldestInScope("assistant", assistantBudget);
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
  // Byte high-water eviction, oldest-first (Map preserves insertion order).
  while (storedResponseBytes > MAX_STORED_RESPONSE_BYTES && states.size > 1) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
}

export function getResponseStateScopeBytes(): Record<ResponseStateScope, number> {
  return { ...storedScopeBytes };
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  pruneResponses();
  const previous = states.get(previousId);
  if (!previous) return body;
  const expanded = {
    ...request,
    input: [...previous.items, ...inputItems(request.input)],
  };
  replayedInputPrefixLengths.set(expanded, previous.items.length);
  return expanded;
}

/** Number of leading input items restored from previous_response_id state for this exact body. */
export function previousResponseReplayPrefixLength(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return replayedInputPrefixLengths.get(body) ?? 0;
}

/**
 * Cache completed output and max_output_tokens partial output for previous_response_id replay.
 * Content-filtered incomplete and failed output are not authoritative replay history.
 */
export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown; incomplete_details?: unknown },
  opts?: { force?: boolean; scope?: ResponseStateScope },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally; the
  // store stays in-memory with a 1h TTL, so this is a proxy-internal continuation cache, not
  // real server-side response storage.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
      || (details as { reason?: unknown }).reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  setEntry(response.id, {
    createdAt: now(),
    items: [...inputItems(request.input), ...response.output],
    schemaVersion: 2,
    scope: normalizeScope(opts?.scope),
  });
  pruneResponses();
  schedulePersist();
}
