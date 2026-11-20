import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeEffectivePersonalizationDigest,
  createDefaultPersonalizationSettings,
  PERSONALIZATION_LIMITS,
  PersonalizationPromptBuilder,
  PersonalizationStore,
  sanitizePersonalizationSettings,
  type PersonalizationSettings,
} from "../src/personalization";
import { CodexPayloadNormalizer, CodexRawPayload } from "../src/adapters/web/normalization";
import { WebPromptSessionStore } from "../src/adapters/web/execution/web-prompt-session-store";
import { compileWebPrompt } from "../src/adapters/web/compile-prompt";
import { parseRequest } from "../src/responses/parser";
import { renderGlobalPersonalizationPreview } from "../launcher/src/personalization-preview";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("Personalization & Workspace Memory 2 tầng", () => {
  test("PersonalizationStore trả về default khi chưa có file và hot-reload khi file thay đổi", () => {
    const dir = makeTempDir("codex-personalization-store-");
    const filePath = join(dir, "personalization.json");
    try {
      const store = new PersonalizationStore(filePath);
      const initial = store.getSnapshot();
      expect(initial.settings.enabled).toBe(false);
      expect(initial.digest).toBe("");

      const payload1: PersonalizationSettings = {
        ...createDefaultPersonalizationSettings(),
        enabled: true,
        nickname: "Huy",
        baseTone: "concise_technical",
        memories: [
          {
            id: "m1",
            content: "Luôn dùng Bun thay vì Python",
            enabled: true,
            createdAt: "2026-11-20T00:00:00.000Z",
            updatedAt: "2026-11-20T00:00:00.000Z",
          },
          {
            id: "m2",
            content: "Mục bị tắt không nên ảnh hưởng digest",
            enabled: false,
            createdAt: "2026-11-20T00:00:00.000Z",
            updatedAt: "2026-11-20T00:00:00.000Z",
          },
        ],
      };
      writeFileSync(filePath, JSON.stringify(payload1), "utf8");
      const snap1 = store.getSnapshot();
      expect(snap1.settings.enabled).toBe(true);
      expect(snap1.settings.nickname).toBe("Huy");
      expect(snap1.digest).not.toBe("");

      // Tắt hẳn memory m2 -> digest không đổi; nhưng đổi nội dung memory đang bật -> digest đổi ngay
      const payload2: PersonalizationSettings = {
        ...payload1,
        memories: [
          payload1.memories[0],
          { ...payload1.memories[1], content: "Sửa nội dung mục đang off" },
        ],
      };
      expect(computeEffectivePersonalizationDigest(payload2)).toBe(snap1.digest);

      const payload3: PersonalizationSettings = {
        ...payload1,
        customInstructions: "Luôn phản hồi bằng Tiếng Việt",
      };
      writeFileSync(filePath, JSON.stringify(payload3), "utf8");
      const bumpedTime = new Date(Date.now() + 5_000);
      utimesSync(filePath, bumpedTime, bumpedTime);

      const snap2 = store.getSnapshot();
      expect(snap2.settings.customInstructions).toBe("Luôn phản hồi bằng Tiếng Việt");
      expect(snap2.digest).not.toBe(snap1.digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sanitizePersonalizationSettings cắt đúng giới hạn ký tự và số lượng memory", () => {
    const manyMemories = Array.from({ length: 65 }, (_, index) => ({
      id: `id-${index}`,
      content: `${index}-` + "x".repeat(250),
      enabled: true,
    }));

    const sanitized = sanitizePersonalizationSettings({
      enabled: true,
      workspaceMemoryEnabled: false,
      baseTone: "invalid_tone",
      nickname: "N".repeat(120),
      roleOrStack: "R".repeat(300),
      aboutYou: "A".repeat(700),
      customInstructions: "C".repeat(2_000),
      memories: manyMemories,
    });

    expect(sanitized.enabled).toBe(true);
    expect(sanitized.workspaceMemoryEnabled).toBe(false);
    expect(sanitized.baseTone).toBe("default");
    expect(sanitized.nickname.length).toBe(PERSONALIZATION_LIMITS.nickname);
    expect(sanitized.roleOrStack.length).toBe(PERSONALIZATION_LIMITS.roleOrStack);
    expect(sanitized.aboutYou.length).toBe(PERSONALIZATION_LIMITS.aboutYou);
    expect(sanitized.customInstructions.length).toBe(PERSONALIZATION_LIMITS.customInstructions);
    expect(sanitized.memories.length).toBe(PERSONALIZATION_LIMITS.maxMemories);
    expect(sanitized.memories[0].content.length).toBe(PERSONALIZATION_LIMITS.memoryContent);
  });

  test("PersonalizationPromptBuilder render Global section khớp 1:1 với Launcher preview và tách 2 trạng thái Workspace Memory", () => {
    const dir = makeTempDir("codex-workspace-memory-");
    const builder = new PersonalizationPromptBuilder();
    try {
      const settings: PersonalizationSettings = {
        ...createDefaultPersonalizationSettings(),
        enabled: true,
        baseTone: "mentor",
        nickname: "Huy",
        roleOrStack: "TypeScript / Electron",
        aboutYou: "Thích code sạch, phản biện thẳng",
        customInstructions: "Luôn giải thích trade-off trước khi sửa lớn",
        memories: [
          {
            id: "1",
            content: "Không tự ý git push",
            enabled: true,
            createdAt: "2026-11-20T00:00:00.000Z",
            updatedAt: "2026-11-20T00:00:00.000Z",
          },
          {
            id: "2",
            content: "Memory đang tắt",
            enabled: false,
            createdAt: "2026-11-20T00:00:00.000Z",
            updatedAt: "2026-11-20T00:00:00.000Z",
          },
        ],
      };

      const globalText = builder.buildGlobalSection(settings);
      expect(globalText).toContain("AGENTS.md hoặc developer instructions) luôn được ưu tiên cao hơn");
      expect(globalText).toContain("Không tự ý git push");
      expect(globalText).not.toContain("Memory đang tắt");

      // Parity check giữa backend runtime và Launcher preview
      expect(renderGlobalPersonalizationPreview(settings)).toBe(globalText);

      // Trường hợp 1: chưa có .codex-copilot/
      const missingHint = builder.buildWorkspaceMemoryHint(dir, true);
      expect(missingHint).toContain("chưa có thư mục `.codex-copilot/`");
      expect(missingHint).toContain("không cần chạy lệnh kiểm tra ở đầu phiên");

      // Trường hợp 2: đã có .codex-copilot/ với MEMORY.md + các file .md khác
      const memDir = join(dir, ".codex-copilot");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "decisions.md"), "# Decisions", "utf8");
      writeFileSync(join(memDir, "MEMORY.md"), "# Index", "utf8");
      writeFileSync(join(memDir, "ignore.txt"), "not markdown", "utf8");

      const populatedHint = builder.buildWorkspaceMemoryHint(dir, true);
      expect(populatedHint).toContain("MEMORY.md, decisions.md");
      expect(populatedHint).not.toContain("ignore.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WebPromptSessionStore & WebPromptCompiler inject đúng lúc, chèn lại khi sửa giữa phiên và bỏ qua STRUCTURED_JSON_OUTPUT / TOOL_RESULT", () => {
    const dir = makeTempDir("codex-personalization-compile-");
    try {
      const store = new WebPromptSessionStore();
      const builder = new PersonalizationPromptBuilder();
      const settings: PersonalizationSettings = {
        ...createDefaultPersonalizationSettings(),
        enabled: true,
        workspaceMemoryEnabled: true,
        nickname: "Huy",
        customInstructions: "Luôn trả lời bằng Tiếng Việt",
      };
      const digest1 = computeEffectivePersonalizationDigest(settings);
      const globalText1 = builder.buildGlobalSection(settings);
      const wsHint = builder.buildWorkspaceMemoryHint(dir, true);

      // Turn 1 (FIRST_HANDSHAKE) với environmentContext chứa cwd
      const turn1Raw = {
        model: "m365/gpt-5.2",
        input: [
          {
            type: "message",
            role: "user",
            content: `<environment_context>\n  <cwd>${dir}</cwd>\n  <shell>zsh</shell>\n</environment_context>`,
          },
          {
            type: "message",
            role: "user",
            content: "Hãy phân tích cấu trúc thư mục này",
          },
        ],
        tools: [
          {
            type: "function",
            name: "exec_command",
            description: "Run shell",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
        ],
      };

      const parsed1 = parseRequest(turn1Raw);
      const norm1 = CodexPayloadNormalizer.normalize(CodexRawPayload.from(turn1Raw), { parsed: parsed1 });
      expect(norm1.workspaceCwd).toBe(dir);

      const dir1 = store.resolveTurnDirectives("sess-1", {
        isNewConversation: true,
        normalized: norm1,
        personalizationDigest: digest1,
      });
      expect(dir1.includePersonalization).toBe(true);

      const compiled1 = compileWebPrompt(parsed1, {
        assistantName: "Copilot",
        isNewConversation: true,
        normalized: norm1,
        includePersonalization: true,
        personalizationText: globalText1,
        workspaceMemoryHintText: wsHint,
      });
      expect(compiled1.scenario).toBe("FIRST_HANDSHAKE");
      expect(compiled1.finalPrompt).toContain("Luôn trả lời bằng Tiếng Việt");
      expect(compiled1.finalPrompt).toContain("[Bộ nhớ Workspace (.codex-copilot/)]");
      store.commitTurnPrompt("sess-1", norm1, [], digest1);

      // Turn 2: TOOL_RESULT_CONTINUATION với digest không đổi -> không chèn lại Global & không chèn Workspace hint
      const turn2Raw = {
        model: "m365/gpt-5.2",
        input: [
          ...turn1Raw.input,
          { type: "message", role: "assistant", content: "Đang chạy lệnh..." },
          { type: "function_call", call_id: "call_1", name: "exec_command", arguments: '{"cmd":"ls"}' },
          { type: "function_call_output", call_id: "call_1", output: "README.md" },
        ],
      };
      const parsed2 = parseRequest(turn2Raw);
      const norm2 = CodexPayloadNormalizer.normalize(CodexRawPayload.from(turn2Raw), { parsed: parsed2 });
      const dir2 = store.resolveTurnDirectives("sess-1", {
        isNewConversation: false,
        normalized: norm2,
        personalizationDigest: digest1,
      });
      expect(dir2.includePersonalization).toBe(false);

      const compiled2 = compileWebPrompt(parsed2, {
        assistantName: "Copilot",
        isNewConversation: false,
        normalized: norm2,
        includePersonalization: true,
        personalizationText: dir2.includePersonalization ? globalText1 : "",
        workspaceMemoryHintText: wsHint,
      });
      expect(compiled2.scenario).toBe("TOOL_RESULT_CONTINUATION");
      expect(compiled2.finalPrompt).not.toContain("Luôn trả lời bằng Tiếng Việt");
      expect(compiled2.finalPrompt).not.toContain("[Bộ nhớ Workspace (.codex-copilot/)]");

      // Turn 3: PURE_CONVERSATION nhưng user vừa sửa Personalization -> chèn lại Global đúng 1 lần + giữ Workspace hint
      const updatedSettings: PersonalizationSettings = {
        ...settings,
        customInstructions: "Viết câu trả lời cực ngắn gọn",
      };
      const digest2 = computeEffectivePersonalizationDigest(updatedSettings);
      const globalText2 = builder.buildGlobalSection(updatedSettings);

      const turn3Raw = {
        model: "m365/gpt-5.2",
        input: [
          {
            type: "message",
            role: "user",
            content: `<environment_context>\n  <cwd>${dir}</cwd>\n</environment_context>`,
          },
          { type: "message", role: "user", content: "Câu hỏi đầu" },
          { type: "message", role: "assistant", content: "Câu trả lời đầu" },
          { type: "message", role: "user", content: "Giải thích thêm phần build" },
        ],
      };
      const parsed3 = parseRequest(turn3Raw);
      const norm3 = CodexPayloadNormalizer.normalize(CodexRawPayload.from(turn3Raw), { parsed: parsed3 });
      const dir3 = store.resolveTurnDirectives("sess-1", {
        isNewConversation: false,
        normalized: norm3,
        personalizationDigest: digest2,
      });
      expect(dir3.includePersonalization).toBe(true);

      const compiled3 = compileWebPrompt(parsed3, {
        assistantName: "Copilot",
        isNewConversation: false,
        normalized: norm3,
        includePersonalization: true,
        personalizationText: globalText2,
        workspaceMemoryHintText: wsHint,
      });
      expect(compiled3.scenario).toBe("PURE_CONVERSATION");
      expect(compiled3.finalPrompt).toContain("Viết câu trả lời cực ngắn gọn");
      expect(compiled3.finalPrompt).toContain("[Bộ nhớ Workspace (.codex-copilot/)]");
      store.commitTurnPrompt("sess-1", norm3, [], digest2);

      // Turn 4: STRUCTURED_JSON_OUTPUT -> bỏ qua hoàn toàn cả Global và Workspace hint
      const turn4Raw = {
        model: "m365/gpt-5.2",
        text: {
          format: {
            type: "json_schema",
            name: "thread_title",
            strict: true,
            schema: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
            },
          },
        },
        input: [{ type: "message", role: "user", content: "Tạo tiêu đề" }],
      };
      const parsed4 = parseRequest(turn4Raw);
      const norm4 = CodexPayloadNormalizer.normalize(CodexRawPayload.from(turn4Raw), { parsed: parsed4 });
      const compiled4 = compileWebPrompt(parsed4, {
        assistantName: "Copilot",
        isNewConversation: true,
        normalized: norm4,
        includePersonalization: true,
        personalizationText: globalText2,
        workspaceMemoryHintText: wsHint,
      });
      expect(compiled4.scenario).toBe("STRUCTURED_JSON_OUTPUT");
      expect(compiled4.finalPrompt).not.toContain("Viết câu trả lời cực ngắn gọn");
      expect(compiled4.finalPrompt).not.toContain("[Bộ nhớ Workspace (.codex-copilot/)]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Budget Guard cắt priorHistory trước để giữ nguyên Personalization ở Turn 1", () => {
    const settings: PersonalizationSettings = {
      ...createDefaultPersonalizationSettings(),
      enabled: true,
      customInstructions: "QUY_TAC_CA_NHAN_QUAN_TRONG",
    };
    const globalText = new PersonalizationPromptBuilder().buildGlobalSection(settings);
    const raw = {
      model: "m365/gpt-5.2",
      input: [
        { type: "message", role: "user", content: "Hỏi cũ 1: " + "X".repeat(8_000) },
        { type: "message", role: "assistant", content: "Đáp cũ 1: " + "Y".repeat(8_000) },
        { type: "message", role: "user", content: "Yêu cầu mới nhất của tôi" },
      ],
    };
    const parsed = parseRequest(raw);
    const norm = CodexPayloadNormalizer.normalize(CodexRawPayload.from(raw), { parsed });
    const result = compileWebPrompt(parsed, {
      assistantName: "Copilot",
      isNewConversation: true,
      maxPromptChars: 6_500,
      normalized: norm,
      includePersonalization: true,
      personalizationText: globalText,
      workspaceMemoryHintText: "",
    });
    expect(result.finalPrompt.length).toBeLessThanOrEqual(6_500);
    expect(result.finalPrompt).toContain("QUY_TAC_CA_NHAN_QUAN_TRONG");
    expect(result.finalPrompt).toContain("Yêu cầu mới nhất của tôi");
  });
});
