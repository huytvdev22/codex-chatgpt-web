import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PERSONALIZATION_TONE_DESCRIPTIONS,
  type PersonalizationSettings,
} from "./types";

const MAX_LISTED_WORKSPACE_FILES = 15;
const WORKSPACE_MEMORY_DIR = ".codex-copilot";

/**
 * Biên dịch phần Global Personalization và gợi ý Workspace Memory (`<cwd>/.codex-copilot/`)
 * thành khối văn bản tự nhiên chèn vào prompt của `/v1/responses`.
 */
export class PersonalizationPromptBuilder {
  /**
   * Dựng khối `[Thông tin cá nhân hóa của người dùng (mặc định chung)]`.
   * Trả về chuỗi rỗng nếu tính năng đang tắt hoặc chưa có nội dung nào đang bật.
   */
  public buildGlobalSection(settings: PersonalizationSettings): string {
    if (!settings.enabled) return "";

    const lines: string[] = [];
    if (settings.nickname) {
      lines.push(`- Tên / Xưng hô mong muốn: ${settings.nickname}`);
    }
    if (settings.roleOrStack) {
      lines.push(`- Vai trò / Tech stack chính: ${settings.roleOrStack}`);
    }
    if (settings.aboutYou) {
      lines.push(`- Giới thiệu thêm về người dùng: ${settings.aboutYou}`);
    }
    const toneDesc = PERSONALIZATION_TONE_DESCRIPTIONS[settings.baseTone];
    if (toneDesc) {
      lines.push(`- Phong cách trả lời ưu tiên: ${toneDesc}`);
    }
    if (settings.customInstructions) {
      lines.push(`- Chỉ dẫn tùy chỉnh:\n${settings.customInstructions}`);
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

  /**
   * Kiểm tra nhanh `<cwd>/.codex-copilot/` (chỉ đọc tên file, không đọc nội dung)
   * và sinh gợi ý gọn nhẹ để AI chủ động đọc khi cần hoặc đề xuất đúc rút cuối task lớn.
   */
  public buildWorkspaceMemoryHint(
    workspaceCwd: string | undefined,
    enabled: boolean,
  ): string {
    if (!enabled) return "";
    const trimmedCwd = workspaceCwd?.trim();
    if (!trimmedCwd) return "";

    const memoryFiles = this.listWorkspaceMemoryFiles(trimmedCwd);
    const memoryDirDisplay = `${WORKSPACE_MEMORY_DIR}/`;

    if (memoryFiles.length > 0) {
      const visibleFiles = memoryFiles.slice(0, MAX_LISTED_WORKSPACE_FILES);
      const overflowCount = memoryFiles.length - visibleFiles.length;
      const fileList =
        overflowCount > 0
          ? `${visibleFiles.join(", ")} (+${overflowCount} file khác)`
          : visibleFiles.join(", ");

      return [
        `[Bộ nhớ Workspace (${memoryDirDisplay})]:`,
        `- Workspace hiện có sẵn các file ghi nhớ: ${fileList} (trong \`${memoryDirDisplay}\`, file chính là \`MEMORY.md\`). Hãy chủ động đọc các file liên quan bằng công cụ khi cần ngữ cảnh dự án.`,
        `- Sau khi hoàn thành một task lớn có bài học hoặc quyết định dài hạn đáng lưu lại cho workspace này, hãy chủ động đề xuất đúc rút/cập nhật vào \`${memoryDirDisplay}MEMORY.md\` (và hỏi kiểm tra \`.gitignore\` nếu đang ở trong repo Git).`,
      ].join("\n");
    }

    return [
      `[Bộ nhớ Workspace (${memoryDirDisplay})]:`,
      `- Workspace này hiện chưa có thư mục \`${memoryDirDisplay}\` (không cần chạy lệnh kiểm tra ở đầu phiên).`,
      `- Sau khi hoàn thành một task lớn có kinh nghiệm, quyết định kiến trúc hoặc ngữ cảnh dài hạn đáng lưu riêng cho thư mục này, hãy chủ động đề xuất tạo \`${memoryDirDisplay}MEMORY.md\` (gộp gọn theo chủ đề, không tạo trùng lặp; nếu là repo Git thì nhắc kiểm tra \`.gitignore\`).`,
    ].join("\n");
  }

  private listWorkspaceMemoryFiles(workspaceCwd: string): string[] {
    try {
      const memoryDir = join(workspaceCwd, WORKSPACE_MEMORY_DIR);
      if (!existsSync(memoryDir)) return [];
      const dirStat = statSync(memoryDir);
      if (!dirStat.isDirectory()) return [];

      const entries = readdirSync(memoryDir, { withFileTypes: true });
      const mdFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .map((entry) => entry.name);

      mdFiles.sort((a, b) => {
        const aIsMain = a.toUpperCase() === "MEMORY.MD";
        const bIsMain = b.toUpperCase() === "MEMORY.MD";
        if (aIsMain !== bIsMain) return aIsMain ? -1 : 1;
        return a.localeCompare(b);
      });

      return mdFiles;
    } catch {
      return [];
    }
  }
}

export const personalizationPromptBuilder = new PersonalizationPromptBuilder();
