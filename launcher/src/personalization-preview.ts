import type { PersonalizationSettings, PersonalizationTone } from "./types";

export const PERSONALIZATION_LIMITS = {
  nickname: 80,
  roleOrStack: 200,
  aboutYou: 500,
  customInstructions: 1500,
  memoryContent: 200,
  maxMemories: 50,
} as const;

export const PERSONALIZATION_TONE_DESCRIPTIONS: Record<PersonalizationTone, string> = {
  default: "",
  concise_technical: "Ngắn gọn, trực diện, ưu tiên kỹ thuật và ví dụ code cụ thể, hạn chế giải thích vòng vo.",
  friendly: "Thân thiện, gần gũi, khích lệ nhưng vẫn rõ ràng và chính xác.",
  formal: "Chuyên nghiệp, trang trọng, mạch lạc theo cấu trúc chuẩn mực.",
  mentor: "Phân tích có chiều sâu, giải thích rõ lý do/trade-off và định hướng tư duy phản biện.",
};

/**
 * Render khối Global Personalization trùng khớp 1:1 với `PersonalizationPromptBuilder` bên runtime.
 */
export function renderGlobalPersonalizationPreview(settings: PersonalizationSettings): string {
  if (!settings.enabled) return "";

  const lines: string[] = [];
  const nickname = settings.nickname.replace(/\r\n/g, "\n").trim();
  const roleOrStack = settings.roleOrStack.replace(/\r\n/g, "\n").trim();
  const aboutYou = settings.aboutYou.replace(/\r\n/g, "\n").trim();
  const customInstructions = settings.customInstructions.replace(/\r\n/g, "\n").trim();

  if (nickname) {
    lines.push(`- Tên / Xưng hô mong muốn: ${nickname}`);
  }
  if (roleOrStack) {
    lines.push(`- Vai trò / Tech stack chính: ${roleOrStack}`);
  }
  if (aboutYou) {
    lines.push(`- Giới thiệu thêm về người dùng: ${aboutYou}`);
  }
  const toneDesc = PERSONALIZATION_TONE_DESCRIPTIONS[settings.baseTone];
  if (toneDesc) {
    lines.push(`- Phong cách trả lời ưu tiên: ${toneDesc}`);
  }
  if (customInstructions) {
    lines.push(`- Chỉ dẫn tùy chỉnh:\n${customInstructions}`);
  }

  const activeMemories = settings.memories
    .filter((item) => item.enabled && item.content.trim().length > 0)
    .map((item) => item.content.trim());

  if (activeMemories.length > 0) {
    lines.push("- Ghi nhớ cá nhân đã lưu:");
    for (const memory of activeMemories) {
      lines.push(`  • ${memory}`);
    }
  }

  if (lines.length === 0) return "";

  return [
    "[Thông tin cá nhân hóa của người dùng (mặc định chung)]:",
    "Lưu ý ưu tiên: Các quy tắc riêng của dự án hiện tại (như AGENTS.md hoặc developer instructions) luôn được ưu tiên cao hơn nếu có xung đột.",
    ...lines,
  ].join("\n");
}

export function renderFullPersonalizationPreview(settings: PersonalizationSettings): string {
  const globalBlock = renderGlobalPersonalizationPreview(settings);
  const parts: string[] = [];
  if (globalBlock) {
    parts.push(globalBlock);
  }
  if (settings.enabled && settings.workspaceMemoryEnabled) {
    parts.push(
      [
        "[Bộ nhớ Workspace (.codex-copilot/)]:",
        "- Tự động kiểm tra sự tồn tại của `<cwd>/.codex-copilot/` (liệt kê tên file `.md` nếu có, ưu tiên `MEMORY.md`) và gợi ý AI chủ động đọc khi cần hoặc đề xuất đúc rút sau task lớn.",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}
