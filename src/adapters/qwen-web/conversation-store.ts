import { join } from "node:path";
import type { CodexParsedRequest } from "../../types";
import { isValidQwenConversationId, extractConversationIdFromUrl } from "./selectors";
import {
  buildWebConversationKey,
  GenericConversationStore,
} from "../web/conversation";

export const QWEN_HOME_URL = "https://chat.qwen.ai/";

export function qwenConversationUrl(conversationId: string): string {
  if (!isValidQwenConversationId(conversationId)) {
    throw new Error(`invalid Qwen conversation ID: ${conversationId}`);
  }
  return `https://chat.qwen.ai/c/${conversationId.toLowerCase()}`;
}

export function parseQwenConversationId(url: string): string | null {
  return extractConversationIdFromUrl(url);
}

export function resolveQwenTargetUrl(conversationId?: string): string {
  if (conversationId && isValidQwenConversationId(conversationId)) {
    return qwenConversationUrl(conversationId);
  }
  return QWEN_HOME_URL;
}

/**
 * Tạo khóa định danh ổn định (conversationKey) từ threadId của Codex cho Qwen Web
 */
export function qwenConversationKey(
  _parsed: CodexParsedRequest,
  rawConversationKey?: string,
): string | undefined {
  return buildWebConversationKey({
    provider: "qwen-web",
    source: rawConversationKey,
    modelId: "qwen-web",
  });
}

export interface QwenConversationRecord {
  conversationId: string;
  createdAt: number;
  updatedAt: number;
}

export class QwenConversationStore {
  private readonly store: GenericConversationStore<"conversationId">;

  constructor(filePath?: string) {
    const resolvedPath =
      filePath ||
      process.env.QWEN_CONVERSATIONS_FILE ||
      join(process.cwd(), "scratch", ".qwen", "qwen-conversations.json");
    this.store = new GenericConversationStore({
      filePath: resolvedPath,
      idField: "conversationId",
      isValidId: isValidQwenConversationId,
      onSaveError: (err, fp) => {
        console.error(`[Qwen ConversationStore] Không thể lưu file ${fp}:`, err);
      },
    });
  }

  public getConversationId(threadId: string | undefined): string | undefined {
    return this.store.getId(threadId);
  }

  public setConversationId(threadId: string | undefined, conversationId: string): void {
    this.store.setId(threadId, conversationId);
  }

  public deleteConversation(threadId: string | undefined): void {
    this.store.deleteKey(threadId);
  }

  public clearAll(): void {
    this.store.clearAll();
  }
}

export const defaultQwenConversationStore = new QwenConversationStore();
