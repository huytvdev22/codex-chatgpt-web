import { join } from "node:path";
import { homedir } from "node:os";
import type { CodexParsedRequest } from "../../types";
import {
  GOOGLE_AI_STUDIO_NEW_CHAT_URL,
  buildGoogleAIStudioPromptUrl,
} from "./selectors";
import { getConfigDir } from "../../config";
import {
  buildWebConversationKey,
  GenericConversationStore,
} from "../web/conversation";

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
  _parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  return buildWebConversationKey({
    provider: "google-ai-studio",
    source: rawConversationKey,
    modelId: "google-ai-studio",
  });
}

export interface GoogleAIStudioConversationRecord {
  promptId: string;
  createdAt: number;
  updatedAt: number;
}

export class GoogleAIStudioConversationStore {
  private readonly store: GenericConversationStore<"promptId">;

  constructor(filePath?: string) {
    const resolvedPath = filePath
      ? filePath
      : join(
          process.env.CODEX_CHATGPT_WEB_HOME ||
            getConfigDir() ||
            join(homedir(), ".codex-google-ai-studio"),
          "google-ai-studio-conversations.json",
        );
    this.store = new GenericConversationStore({
      filePath: resolvedPath,
      idField: "promptId",
      isValidId: id => Boolean(id && id.trim() && id.trim() !== "new_chat"),
    });
  }

  public get(key: string): string | undefined {
    return this.store.getId(key);
  }

  public set(key: string, promptId: string): void {
    const cleanId = promptId.trim();
    if (!cleanId || cleanId === "new_chat") return;
    this.store.setId(key, cleanId);
  }

  public delete(key: string): boolean {
    return this.store.deleteKey(key);
  }
}

export const defaultGoogleAIStudioConversationStore = new GoogleAIStudioConversationStore();
