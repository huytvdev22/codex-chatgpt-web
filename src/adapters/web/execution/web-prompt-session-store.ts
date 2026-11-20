import { createHash } from "node:crypto";
import type { NormalizedCodexRequest, NormalizedTool } from "../normalization/canonical-types";
import type { McpToolDeltaOptions } from "../prompt/mcp-tool-catalog-renderer";
import { GUARD_TTL_MS } from "./turn-guard";

export interface PendingSchemaErrorState {
  toolName: string;
  code: string;
  message: string;
}

export interface WebPromptSessionSnapshot {
  announcedToolDigests: Map<string, string>;
  describedTools: Set<string>;
  lastUserInstructionDigest?: string;
  lastEnvironmentDigest?: string;
  lastPersonalizationDigest?: string;
  lastAvailableSkillsDigest?: string;
  lastSelectedSkillsDigest?: string;
  lastCollaborationMode?: "default" | "plan";
  pendingSchemaError?: PendingSchemaErrorState;
  updatedAt: number;
}

export interface PromptTurnDirectives {
  includeEnvironment: boolean;
  includeUserInstruction: boolean;
  includePersonalization: boolean;
  includeAvailableSkills: boolean;
  includeSelectedSkills: boolean;
  toolDelta?: McpToolDeltaOptions;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function computeToolDigest(tool: NormalizedTool): string {
  const payload =
    tool.kind === "custom"
      ? { kind: "custom", name: tool.identity.qualifiedName, description: tool.description }
      : {
          kind: "function",
          name: tool.identity.qualifiedName,
          description: tool.description,
          rawParameters: tool.rawParameters || {},
        };
  return sha256(JSON.stringify(payload));
}

/**
 * Lưu trữ trạng thái prompt theo phiên (`conversationKey` / `threadId`) để:
 * 1. Bỏ lặp tool list, environment và user instruction cũ ở Turn 2+.
 * 2. Bơm `[MCP TOOL DELTA]` ngay khi danh sách tool thay đổi (ví dụ sau tool_search)
 *    hoặc khi lượt trước gặp lỗi schema/validation.
 * 3. Ghi nhớ các tool đã được tra cứu qua internal `tools.describe`.
 */
export class WebPromptSessionStore {
  private readonly sessions = new Map<string, WebPromptSessionSnapshot>();
  private readonly maxSessions = 1_000;

  clear(sessionKey?: string): void {
    if (!sessionKey) return;
    this.sessions.delete(sessionKey);
  }

  get(sessionKey?: string): WebPromptSessionSnapshot | undefined {
    if (!sessionKey) return undefined;
    this.pruneExpired();
    return this.sessions.get(sessionKey);
  }

  resolveTurnDirectives(
    sessionKey: string | undefined,
    input: {
      isNewConversation: boolean;
      normalized: NormalizedCodexRequest;
      personalizationDigest?: string;
      availableSkillsDigest?: string;
      selectedSkillsDigest?: string;
    },
  ): PromptTurnDirectives {
    const {
      isNewConversation,
      normalized,
      personalizationDigest = "",
      availableSkillsDigest = "",
      selectedSkillsDigest = "",
    } = input;
    const hasToolResults = normalized.trailingToolResults.length > 0;
    const hasPersonalization = personalizationDigest.length > 0;
    const hasAvailableSkills = availableSkillsDigest.length > 0;
    const hasSelectedSkills = selectedSkillsDigest.length > 0;

    if (!sessionKey) {
      return {
        includeEnvironment: isNewConversation || !hasToolResults,
        includeUserInstruction: true,
        includePersonalization: isNewConversation && hasPersonalization,
        includeAvailableSkills: isNewConversation && hasAvailableSkills,
        includeSelectedSkills: hasSelectedSkills && (isNewConversation || !hasToolResults),
        toolDelta: undefined,
      };
    }

    if (isNewConversation) {
      this.sessions.delete(sessionKey);
      return {
        includeEnvironment: true,
        includeUserInstruction: true,
        includePersonalization: hasPersonalization,
        includeAvailableSkills: hasAvailableSkills,
        includeSelectedSkills: hasSelectedSkills,
        toolDelta: undefined,
      };
    }

    this.pruneExpired();
    const snapshot = this.sessions.get(sessionKey);
    if (!snapshot) {
      // Sau khi restart process trên một phiên đã tồn tại: không lặp lại full tool catalog,
      // giữ user instruction 1 lần để thiết lập lại digest cho các turn nối tiếp.
      return {
        includeEnvironment: !hasToolResults,
        includeUserInstruction: true,
        includePersonalization: hasPersonalization && !hasToolResults,
        includeAvailableSkills: hasAvailableSkills && !hasToolResults,
        includeSelectedSkills: hasSelectedSkills && !hasToolResults,
        toolDelta: undefined,
      };
    }

    const currentEnvDigest = normalized.environmentContext
      ? sha256(normalized.environmentContext)
      : undefined;
    const currentUserDigest = normalized.latestUserInstruction
      ? sha256(normalized.latestUserInstruction)
      : undefined;

    const includeEnvironment =
      Boolean(currentEnvDigest) && currentEnvDigest !== snapshot.lastEnvironmentDigest;

    // Trong vòng lặp tool_call nhiều bước (hasToolResults), Codex luôn replay nguyên user instruction cũ.
    // Chỉ hiển thị lại khi thực sự có yêu cầu mới từ người dùng.
    const includeUserInstruction = !hasToolResults
      ? true
      : Boolean(currentUserDigest) && currentUserDigest !== snapshot.lastUserInstructionDigest;

    const includePersonalization =
      hasPersonalization && personalizationDigest !== (snapshot.lastPersonalizationDigest ?? "");

    const includeAvailableSkills =
      hasAvailableSkills &&
      !hasToolResults &&
      availableSkillsDigest !== (snapshot.lastAvailableSkillsDigest ?? "");

    const includeSelectedSkills =
      hasSelectedSkills &&
      (!hasToolResults || selectedSkillsDigest !== (snapshot.lastSelectedSkillsDigest ?? ""));

    const addedTools: NormalizedTool[] = [];
    const currentNames = new Set<string>();
    for (const tool of normalized.activeCodingTools) {
      const qName = tool.identity.qualifiedName || tool.identity.name;
      currentNames.add(qName);
      const digest = computeToolDigest(tool);
      const prevDigest = snapshot.announcedToolDigests.get(qName);
      if (prevDigest !== digest) {
        addedTools.push(tool);
      }
    }

    const removedToolNames: string[] = [];
    for (const prevName of snapshot.announcedToolDigests.keys()) {
      if (!currentNames.has(prevName)) {
        removedToolNames.push(prevName);
      }
    }

    const pendingErr = snapshot.pendingSchemaError;
    const hasDelta =
      addedTools.length > 0 ||
      removedToolNames.length > 0 ||
      pendingErr !== undefined;

    return {
      includeEnvironment,
      includeUserInstruction,
      includePersonalization,
      includeAvailableSkills,
      includeSelectedSkills,
      toolDelta: hasDelta
        ? {
            currentTools: normalized.activeCodingTools,
            addedTools,
            removedToolNames,
            ...(pendingErr
              ? {
                  failedToolName: pendingErr.toolName,
                  failedErrorCode: pendingErr.code,
                  failedErrorMessage: pendingErr.message,
                }
              : {}),
          }
        : undefined,
    };
  }

  commitTurnPrompt(
    sessionKey: string | undefined,
    normalized: NormalizedCodexRequest,
    describedNames: string[] = [],
    personalizationDigest?: string,
    skillsDigests?: {
      availableSkillsDigest?: string;
      selectedSkillsDigest?: string;
    },
  ): void {
    if (!sessionKey) return;
    this.pruneExpired();

    const existing = this.sessions.get(sessionKey);
    const announcedToolDigests = new Map<string, string>();
    for (const tool of normalized.activeCodingTools) {
      const qName = tool.identity.qualifiedName || tool.identity.name;
      announcedToolDigests.set(qName, computeToolDigest(tool));
    }

    const describedTools = new Set<string>(existing?.describedTools ?? []);
    for (const name of describedNames) {
      if (name) describedTools.add(name);
    }

    this.sessions.set(sessionKey, {
      announcedToolDigests,
      describedTools,
      lastUserInstructionDigest: normalized.latestUserInstruction
        ? sha256(normalized.latestUserInstruction)
        : existing?.lastUserInstructionDigest,
      lastEnvironmentDigest: normalized.environmentContext
        ? sha256(normalized.environmentContext)
        : existing?.lastEnvironmentDigest,
      lastPersonalizationDigest:
        personalizationDigest !== undefined
          ? personalizationDigest
          : existing?.lastPersonalizationDigest,
      lastAvailableSkillsDigest:
        skillsDigests?.availableSkillsDigest !== undefined
          ? skillsDigests.availableSkillsDigest
          : existing?.lastAvailableSkillsDigest,
      lastSelectedSkillsDigest:
        skillsDigests?.selectedSkillsDigest !== undefined
          ? skillsDigests.selectedSkillsDigest
          : existing?.lastSelectedSkillsDigest,
      lastCollaborationMode: normalized.collaborationMode,
      pendingSchemaError: undefined,
      updatedAt: Date.now(),
    });
  }

  recordValidationFailure(
    sessionKey: string | undefined,
    failure: PendingSchemaErrorState,
  ): void {
    if (!sessionKey) return;
    const existing = this.sessions.get(sessionKey);
    if (!existing) return;
    existing.pendingSchemaError = failure;
    existing.updatedAt = Date.now();
  }

  private pruneExpired(now = Date.now()): void {
    for (const [key, state] of this.sessions.entries()) {
      if (now - state.updatedAt > GUARD_TTL_MS) {
        this.sessions.delete(key);
      }
    }
    if (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        .slice(0, Math.min(200, this.sessions.size));
      for (const [key] of oldest) {
        this.sessions.delete(key);
      }
    }
  }
}

export const webPromptSessionStore = new WebPromptSessionStore();
