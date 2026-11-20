export type PersonalizationTone =
  | "default"
  | "concise_technical"
  | "friendly"
  | "formal"
  | "mentor";

export interface SavedMemoryItem {
  id: string;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalizationSettings {
  version: 1;
  enabled: boolean;
  workspaceMemoryEnabled: boolean;
  baseTone: PersonalizationTone;
  nickname: string;
  roleOrStack: string;
  aboutYou: string;
  customInstructions: string;
  memories: SavedMemoryItem[];
  updatedAt: string | null;
}

export const PERSONALIZATION_LIMITS = {
  nickname: 80,
  roleOrStack: 200,
  aboutYou: 500,
  customInstructions: 1500,
  memoryContent: 200,
  maxMemories: 50,
} as const;

export const VALID_PERSONALIZATION_TONES: readonly PersonalizationTone[] = [
  "default",
  "concise_technical",
  "friendly",
  "formal",
  "mentor",
] as const;

export const PERSONALIZATION_TONE_DESCRIPTIONS: Record<PersonalizationTone, string> = {
  default: "",
  concise_technical: "Ngắn gọn, trực diện, ưu tiên kỹ thuật và ví dụ code cụ thể, hạn chế giải thích vòng vo.",
  friendly: "Thân thiện, gần gũi, khích lệ nhưng vẫn rõ ràng và chính xác.",
  formal: "Chuyên nghiệp, trang trọng, mạch lạc theo cấu trúc chuẩn mực.",
  mentor: "Phân tích có chiều sâu, giải thích rõ lý do/trade-off và định hướng tư duy phản biện.",
};

export function createDefaultPersonalizationSettings(): PersonalizationSettings {
  return {
    version: 1,
    enabled: false,
    workspaceMemoryEnabled: true,
    baseTone: "default",
    nickname: "",
    roleOrStack: "",
    aboutYou: "",
    customInstructions: "",
    memories: [],
    updatedAt: null,
  };
}
