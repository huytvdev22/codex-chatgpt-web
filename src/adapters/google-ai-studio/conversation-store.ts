import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CodexParsedRequest } from "../../types";
import {
  GOOGLE_AI_STUDIO_NEW_CHAT_URL,
  buildGoogleAIStudioPromptUrl,
  parseGoogleAIStudioPromptId,
} from "./selectors";
import { getConfigDir } from "../../config";

export function resolveGoogleAIStudioTargetUrl(promptId?: string): string {
  if (promptId && promptId !== "new_chat") {
    return buildGoogleAIStudioPromptUrl(promptId);
  }
  return GOOGLE_AI_STUDIO_NEW_CHAT_URL;
}

/**
 * Tạo khóa định danh ổn định (conversationKey) từ threadId của Codex cho Google AI Studio
 */
export function googleAIStudioConversationKey(
  parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  const source = rawConversationKey?.trim();
  if (!source) return undefined;

  return createHash("sha256").update(JSON.stringify({
    provider: "google-ai-studio",
    source,
    modelId: "google-ai-studio",
  })).digest("hex");
}

export interface GoogleAIStudioConversationRecord {
  promptId: string;
  createdAt: number;
  updatedAt: number;
}

export class GoogleAIStudioConversationStore {
  private filePath: string;
  private cache: Map<string, GoogleAIStudioConversationRecord> = new Map();
  private loaded = false;

  constructor(filePath?: string) {
    if (filePath) {
      this.filePath = filePath;
    } else {
      const baseDir = process.env.CODEX_CHATGPT_WEB_HOME || getConfigDir() || join(homedir(), ".codex-google-ai-studio");
      this.filePath = join(baseDir, "google-ai-studio-conversations.json");
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object") {
          for (const [key, value] of Object.entries(data)) {
            let id: string | null = null;
            let rec: GoogleAIStudioConversationRecord | null = null;
            if (typeof value === "string") {
              id = value;
              rec = { promptId: value, createdAt: Date.now(), updatedAt: Date.now() };
            } else if (value && typeof value === "object" && "promptId" in value) {
              rec = value as GoogleAIStudioConversationRecord;
              id = rec.promptId;
            }
            if (id && rec) {
              this.cache.set(key, rec);
            }
          }
        }
      }
    } catch {
      // Bỏ qua lỗi load file
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, GoogleAIStudioConversationRecord> = {};
      this.cache.forEach((record, key) => {
        data[key] = record;
      });
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // Bỏ qua lỗi ghi file
    }
  }

  public get(key: string): string | undefined {
    this.load();
    return this.cache.get(key)?.promptId;
  }

  public set(key: string, promptId: string): void {
    this.load();
    const cleanId = promptId.trim();
    if (!cleanId || cleanId === "new_chat") return;

    const existing = this.cache.get(key);
    const now = Date.now();
    this.cache.set(key, {
      promptId: cleanId,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    });
    this.save();
  }

  public delete(key: string): boolean {
    this.load();
    const deleted = this.cache.delete(key);
    if (deleted) this.save();
    return deleted;
  }
}

export const defaultGoogleAIStudioConversationStore = new GoogleAIStudioConversationStore();
