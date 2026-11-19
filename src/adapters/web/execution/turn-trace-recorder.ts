import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../../config";
import type { CodexParsedRequest } from "../../../types";
import type { NormalizedCodexRequest } from "../normalization/canonical-types";
import type {
  PromptAuditData,
  PromptCompileResult,
  PromptSectionMetrics,
} from "../prompt/compiler";

export interface TurnTraceAttemptRecord {
  attempt: number;
  isRetry: boolean;
  promptLength: number;
  prompt: string;
  rawWebResponse?: string;
  sanitizedWebResponse?: string;
  parsedProtocolResult?: unknown;
  durationMs?: number;
  error?: string;
}

export interface TurnTraceRecord {
  meta: {
    sequence: number;
    capturedAt: string;
    providerId: string;
    assistantName: string;
    modelId: string;
    threadId?: string;
    turnId?: string;
    turnTraceId: string;
    conversationKey?: string;
    existingConversationId?: string;
    activeConversationId?: string;
    launcherReused: boolean;
    isNewConversation: boolean;
    usedCustomCompilePrompt: boolean;
    finalStatus: string;
    durationMs: number;
    error?: string;
  };
  normalizedSummary: {
    collaborationMode: "default" | "plan";
    isPlanMode?: boolean;
    isImplementingPlan?: boolean;
    scenario?: string;
    toolsCount: number;
    activeCodingTools: Array<{
      name: string;
      qualifiedName: string;
      kind: "function" | "custom";
      namespace?: string;
    }>;
    priorHistoryCount: number;
    trailingToolResultsCount: number;
    trailingToolResults: Array<{
      callId: string;
      toolName?: string;
      kind?: "function" | "custom";
      outputLength: number;
    }>;
    developerInstructionsCount: number;
    hasEnvironmentContext: boolean;
    imagesCount: number;
    metrics?: PromptSectionMetrics;
    audit?: PromptAuditData;
  };
  rawCodexRequest: unknown;
  cookedPromptsByAttempt: TurnTraceAttemptRecord[];
}

export interface TurnTraceRecorderOptions {
  /** Bật/tắt tường minh (dùng trong test); nếu undefined sẽ tự đọc env CODEX_WEB_TURN_TRACE. */
  enabled?: boolean;
  /** Thư mục gốc lưu trace; mặc định đọc CODEX_WEB_TURN_TRACE_DIR hoặc `<getConfigDir()>/diagnostics/turn-traces`. */
  outputDir?: string;
}

export interface BeginTurnTraceInput {
  providerId: string;
  assistantName: string;
  modelId: string;
  threadId?: string;
  turnId?: string;
  turnTraceId: string;
  conversationKey?: string;
  existingConversationId?: string;
  launcherReused: boolean;
  isNewConversation: boolean;
  usedCustomCompilePrompt: boolean;
  parsed: CodexParsedRequest;
  normalized: NormalizedCodexRequest;
  compileResult?: PromptCompileResult;
}

const DEFAULT_BASE64_OMIT_THRESHOLD = 512;

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

function formatFileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Thay thế data:image/... base64 hoặc blob file_data quá dài để giữ file trace gọn và dễ đọc.
 */
export function redactLargeTracePayloads(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (value.startsWith("data:image/") && value.includes(";base64,") && value.length > DEFAULT_BASE64_OMIT_THRESHOLD) {
      const header = value.slice(0, value.indexOf(";base64,") + ";base64,".length);
      return `[${header}<omitted ${value.length} chars>]`;
    }
    return value;
  }

  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => redactLargeTracePayloads(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "file_data" && typeof entry === "string" && entry.length > DEFAULT_BASE64_OMIT_THRESHOLD) {
      out[key] = `[file_data omitted (${entry.length} chars)]`;
      continue;
    }
    if (key === "dataUrl" && typeof entry === "string" && entry.length > DEFAULT_BASE64_OMIT_THRESHOLD) {
      out[key] = `[dataUrl omitted (${entry.length} chars)]`;
      continue;
    }
    out[key] = redactLargeTracePayloads(entry, seen);
  }
  return out;
}

export class TurnTraceSession {
  private readonly startMs = Date.now();
  private readonly attempts: TurnTraceAttemptRecord[] = [];
  private activeAttemptIndex = -1;
  private activeAttemptStartMs = 0;

  constructor(
    private readonly recorder: TurnTraceRecorder,
    private readonly filePath: string,
    private readonly record: TurnTraceRecord,
  ) {}

  getFilePath(): string {
    return this.filePath;
  }

  recordAttemptPrompt(context: {
    attempt: number;
    isRetry: boolean;
    prompt: string;
  }): void {
    this.activeAttemptStartMs = Date.now();
    const entry: TurnTraceAttemptRecord = {
      attempt: context.attempt,
      isRetry: context.isRetry,
      promptLength: context.prompt.length,
      prompt: context.prompt,
    };
    this.attempts.push(entry);
    this.activeAttemptIndex = this.attempts.length - 1;
    this.record.cookedPromptsByAttempt = this.attempts;
    this.flush("in_progress");
  }

  recordAttemptOutcome(outcome: {
    rawWebResponse?: string;
    sanitizedWebResponse?: string;
    parsedProtocolResult?: unknown;
    error?: unknown;
  }): void {
    const entry = this.attempts[this.activeAttemptIndex];
    if (!entry) return;
    entry.durationMs = Math.max(0, Date.now() - this.activeAttemptStartMs);
    if (outcome.rawWebResponse !== undefined) {
      entry.rawWebResponse = outcome.rawWebResponse;
    }
    if (outcome.sanitizedWebResponse !== undefined) {
      entry.sanitizedWebResponse = outcome.sanitizedWebResponse;
    }
    if (outcome.parsedProtocolResult !== undefined) {
      entry.parsedProtocolResult = outcome.parsedProtocolResult;
    }
    if (outcome.error !== undefined) {
      entry.error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    }
    this.flush("in_progress");
  }

  finalize(status: string, activeConversationId?: string, error?: unknown): void {
    this.record.meta.activeConversationId = activeConversationId;
    if (error !== undefined) {
      this.record.meta.error = error instanceof Error ? error.message : String(error);
    }
    this.flush(status);
  }

  private flush(status: string): void {
    this.record.meta.finalStatus = status;
    this.record.meta.durationMs = Math.max(0, Date.now() - this.startMs);
    this.recorder.writeTraceFile(this.filePath, this.record);
  }
}

/**
 * Ghi lại toàn bộ raw Codex request và cooked prompt từng lượt (1 file/turn)
 * phục vụ phân tích wire format và đối chứng Before/After.
 */
export class TurnTraceRecorder {
  private readonly sessionSequences = new Map<string, number>();
  private announcedRootDir = false;

  constructor(private readonly options: TurnTraceRecorderOptions = {}) {}

  isEnabled(): boolean {
    if (this.options.enabled !== undefined) {
      return this.options.enabled;
    }

    const envFlag = process.env.CODEX_WEB_TURN_TRACE?.trim().toLowerCase();
    return envFlag === "1" || envFlag === "true" || envFlag === "on";
  }

  resolveOutputDir(): string {
    if (this.options.outputDir?.trim()) {
      return this.options.outputDir.trim();
    }
    const envDir = process.env.CODEX_WEB_TURN_TRACE_DIR?.trim();
    if (envDir) {
      return envDir;
    }
    return join(getConfigDir(), "diagnostics", "turn-traces");
  }

  beginTurn(input: BeginTurnTraceInput): TurnTraceSession | null {
    if (!this.isEnabled()) return null;

    const rootDir = this.resolveOutputDir();
    const sessionKey = input.threadId || input.conversationKey || "no-thread";
    const sessionFolder = sanitizePathSegment(sessionKey, "no-thread");
    const sessionDir = join(rootDir, sessionFolder);

    try {
      mkdirSync(sessionDir, { recursive: true });
      const seq = this.nextSequence(sessionDir);
      const paddedSeq = String(seq).padStart(3, "0");
      const now = new Date();
      const scenarioSlug = sanitizePathSegment(
        input.compileResult?.scenario || (input.usedCustomCompilePrompt ? "CUSTOM_COMPILE" : "UNKNOWN"),
        "TURN",
      );
      const turnSlug = sanitizePathSegment(
        input.turnId ? input.turnId.slice(-12) : input.turnTraceId.slice(0, 12),
        "trace",
      );
      const fileName = `turn-${paddedSeq}_${formatFileTimestamp(now)}_${scenarioSlug}_${turnSlug}.json`;
      const filePath = join(sessionDir, fileName);

      const rawSource = input.parsed._rawBody !== undefined ? input.parsed._rawBody : input.parsed;
      const record: TurnTraceRecord = {
        meta: {
          sequence: seq,
          capturedAt: now.toISOString(),
          providerId: input.providerId,
          assistantName: input.assistantName,
          modelId: input.modelId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.turnId ? { turnId: input.turnId } : {}),
          turnTraceId: input.turnTraceId,
          ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
          ...(input.existingConversationId ? { existingConversationId: input.existingConversationId } : {}),
          launcherReused: input.launcherReused,
          isNewConversation: input.isNewConversation,
          usedCustomCompilePrompt: input.usedCustomCompilePrompt,
          finalStatus: "started",
          durationMs: 0,
        },
        normalizedSummary: {
          collaborationMode: input.compileResult?.collaborationMode ?? input.normalized.collaborationMode,
          ...(input.compileResult ? {
            isPlanMode: input.compileResult.isPlanMode,
            isImplementingPlan: input.compileResult.isImplementingPlan,
            scenario: input.compileResult.scenario,
          } : {}),
          toolsCount: input.normalized.activeCodingTools.length,
          activeCodingTools: input.normalized.activeCodingTools.map(tool => ({
            name: tool.identity.name,
            qualifiedName: tool.identity.qualifiedName,
            kind: tool.kind,
            ...(tool.identity.namespace ? { namespace: tool.identity.namespace } : {}),
          })),
          priorHistoryCount: input.normalized.priorHistory.length,
          trailingToolResultsCount: input.normalized.trailingToolResults.length,
          trailingToolResults: input.normalized.trailingToolResults.map(res => ({
            callId: res.callId,
            ...(res.toolName ? { toolName: res.toolName } : {}),
            ...(res.kind ? { kind: res.kind } : {}),
            outputLength: res.output.length,
          })),
          developerInstructionsCount: input.normalized.developerInstructions?.length || 0,
          hasEnvironmentContext: Boolean(input.normalized.environmentContext),
          imagesCount: input.normalized.images?.length || 0,
          ...(input.compileResult?.metrics ? { metrics: input.compileResult.metrics } : {}),
          ...(input.compileResult?.audit ? { audit: input.compileResult.audit } : {}),
        },
        rawCodexRequest: redactLargeTracePayloads(rawSource),
        cookedPromptsByAttempt: [],
      };

      if (!this.announcedRootDir) {
        this.announcedRootDir = true;
        console.log(`[turn-trace] Capturing turns into: ${rootDir}`);
      }
      console.log(`[turn-trace] Turn #${paddedSeq} (${scenarioSlug}) -> ${filePath}`);

      this.writeTraceFile(filePath, record);
      return new TurnTraceSession(this, filePath, record);
    } catch (error) {
      console.warn(
        `[turn-trace] Failed to initialize turn trace: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  writeTraceFile(filePath: string, record: TurnTraceRecord): void {
    try {
      writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    } catch (error) {
      console.warn(
        `[turn-trace] Failed to write turn trace '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private nextSequence(sessionDir: string): number {
    const cached = this.sessionSequences.get(sessionDir);
    if (cached !== undefined) {
      const next = cached + 1;
      this.sessionSequences.set(sessionDir, next);
      return next;
    }

    let existingMax = 0;
    try {
      for (const name of readdirSync(sessionDir)) {
        const match = /^turn-(\d+)_/.exec(name);
        if (match) {
          const parsed = Number.parseInt(match[1], 10);
          if (Number.isFinite(parsed) && parsed > existingMax) {
            existingMax = parsed;
          }
        }
      }
    } catch {
      existingMax = 0;
    }

    const next = existingMax + 1;
    this.sessionSequences.set(sessionDir, next);
    return next;
  }
}
