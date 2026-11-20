import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexPayloadNormalizer, CodexRawPayload } from "../src/adapters/web/normalization";
import { WebPromptSessionStore } from "../src/adapters/web/execution/web-prompt-session-store";
import { WebPromptCompiler } from "../src/adapters/web/prompt";
import {
  CodexSkillParser,
  SkillDirectoryScanner,
  SkillPromptBuilder,
  SkillsStore,
  createDefaultSkillsSettings,
} from "../src/skills";

const SAMPLE_SKILLS_INSTRUCTIONS = `<skills_instructions>
## Skills
### Skill roots
- \`r0\` = \`/Users/dev/.codex/skills/.system\`
- \`r1\` = \`/repo/my-app/.agents/skills\`
- \`r2\` = \`/Users/dev/.agents/skills\`
### Available skills
- imagegen: Generate bitmap images. (file: r0/imagegen/SKILL.md)
- openai-docs: Answer Codex API docs questions. (file: r0/openai-docs/SKILL.md)
- e2e-codex-cli-test: Runbook E2E test bang Codex CLI. (file: r1/e2e-codex-cli-test/SKILL.md)
- my-global-skill: Custom user skill. (file: r2/my-global-skill/SKILL.md)
</skills_instructions>`;

const SAMPLE_SELECTED_SKILL = `<skill>
<name>e2e-codex-cli-test</name>
<path>/repo/my-app/.agents/skills/e2e-codex-cli-test/SKILL.md</path>
---
name: e2e-codex-cli-test
description: Runbook E2E test
---

# Huong dan E2E
Chay CODEX_WEB_TURN_TRACE=1 npm run launcher:start
</skill>`;

describe("Native Codex Skills Bridge", () => {
  test("CodexSkillParser mở rộng alias r0/r1/r2 và phân loại đúng system vs workspace vs user", () => {
    const parsed = CodexSkillParser.extractHostSkills(
      SAMPLE_SKILLS_INSTRUCTIONS,
      "/repo/my-app",
    );

    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toEqual({
      name: "imagegen",
      description: "Generate bitmap images.",
      shortPath: "r0/imagegen/SKILL.md",
      absolutePath: "/Users/dev/.codex/skills/.system/imagegen/SKILL.md",
      source: "system",
    });
    expect(parsed[2]).toEqual({
      name: "e2e-codex-cli-test",
      description: "Runbook E2E test bang Codex CLI.",
      shortPath: "r1/e2e-codex-cli-test/SKILL.md",
      absolutePath: "/repo/my-app/.agents/skills/e2e-codex-cli-test/SKILL.md",
      source: "workspace",
    });
    expect(parsed[3]?.source).toBe("user");
  });

  test("SkillPromptBuilder mặc định ẩn system skills và chỉ render name -> path siêu tối giản", () => {
    const builder = new SkillPromptBuilder();
    const parsed = CodexSkillParser.extractHostSkills(
      SAMPLE_SKILLS_INSTRUCTIONS,
      "/repo/my-app",
    );
    const settings = createDefaultSkillsSettings();
    const filtered = builder.filterHostSkills(parsed, settings);

    expect(filtered.map((item) => item.name)).toEqual([
      "e2e-codex-cli-test",
      "my-global-skill",
    ]);

    const section = builder.buildAvailableSkillsSection(filtered);
    expect(section).toContain("[Danh sách Skills khả dụng]:");
    expect(section).toContain("- e2e-codex-cli-test -> /repo/my-app/.agents/skills/e2e-codex-cli-test/SKILL.md");
    expect(section).toContain("- my-global-skill -> /Users/dev/.agents/skills/my-global-skill/SKILL.md");
    expect(section).not.toContain("Runbook E2E test bang Codex CLI");
    expect(section).not.toContain("imagegen");

    const withSystem = builder.filterHostSkills(parsed, {
      ...settings,
      includeSystemSkills: true,
      disabledSkills: ["my-global-skill"],
    });
    expect(withSystem.map((item) => item.name)).toEqual([
      "e2e-codex-cli-test",
      "imagegen",
      "openai-docs",
    ]);
  });

  test("SkillsStore hot-reload theo mtimeMs/size và ghi nhận discovered-skills.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-skills-store-"));
    try {
      const settingsPath = join(dir, "skills.json");
      const discoveredPath = join(dir, "discovered-skills.json");
      const store = new SkillsStore(settingsPath, discoveredPath);

      expect(store.getSnapshot().settings.enabled).toBe(true);
      expect(store.getSnapshot().settings.includeSystemSkills).toBe(false);

      writeFileSync(
        settingsPath,
        JSON.stringify({
          version: 1,
          enabled: true,
          autoDiscoverHostSkills: true,
          includeSystemSkills: true,
          disabledSkills: ["openai-docs"],
        }),
      );

      const reloaded = store.getSnapshot().settings;
      expect(reloaded.includeSystemSkills).toBe(true);
      expect(reloaded.disabledSkills).toEqual(["openai-docs"]);

      const parsed = CodexSkillParser.extractHostSkills(
        SAMPLE_SKILLS_INSTRUCTIONS,
        "/repo/my-app",
      );
      store.recordDiscoveredSkills(parsed);
      const cachedRaw = JSON.parse(
        require("node:fs").readFileSync(discoveredPath, "utf8"),
      ) as { skills: Array<{ name: string }> };
      expect(cachedRaw.skills.map((s) => s.name)).toContain("e2e-codex-cli-test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CodexPayloadNormalizer tách selected_skill_instructions ra khỏi priorHistory cho cả Turn 1 và Turn 2+", () => {
    const rawTurn2 = CodexRawPayload.from({
      model: "m365-copilot/gpt-5.6",
      stream: true,
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: SAMPLE_SKILLS_INSTRUCTIONS }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["host_skills.instructions"],
          },
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<environment_context>\n<cwd>/repo/my-app</cwd>\n</environment_context>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["environments.environment_context"],
          },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Turn 1 hello" }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["user.text"],
          },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: SAMPLE_SELECTED_SKILL }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["skills.selected_skill_instructions"],
          },
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Turn 1 done" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Turn 2 dung $e2e-codex-cli-test" }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["user.text"],
          },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: SAMPLE_SELECTED_SKILL }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["skills.selected_skill_instructions"],
          },
        },
      ],
    });

    const normalized = CodexPayloadNormalizer.normalize(rawTurn2);

    expect(normalized.workspaceCwd).toBe("/repo/my-app");
    expect(normalized.latestUserInstruction).toBe("Turn 2 dung $e2e-codex-cli-test");
    expect(normalized.availableSkills?.map((s) => s.name)).toContain("e2e-codex-cli-test");
    expect(normalized.availableSkills?.find((s) => s.name === "e2e-codex-cli-test")?.source).toBe(
      "workspace",
    );
    // Chỉ lấy đúng 1 selectedSkill thuộc Turn 2 (không lấy lại skill cũ ở Turn 1)
    expect(normalized.selectedSkills).toHaveLength(1);
    expect(normalized.selectedSkills?.[0]?.name).toBe("e2e-codex-cli-test");
    // Không bao giờ rò rỉ <skill> vào priorHistory
    expect(
      normalized.priorHistory.some((turn) => turn.content.includes("<skill>")),
    ).toBe(false);
  });

  test("WebPromptSessionStore và WebPromptCompiler chèn selectedSkills ở Turn 2+ và tránh lặp lại ở TOOL_RESULT_CONTINUATION", () => {
    const builder = new SkillPromptBuilder();
    const settings = createDefaultSkillsSettings();
    const sessionStore = new WebPromptSessionStore();
    const compiler = new WebPromptCompiler({ assistantName: "Copilot" });

    const rawTurn2 = CodexRawPayload.from({
      model: "m365-copilot/gpt-5.6",
      stream: true,
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: SAMPLE_SKILLS_INSTRUCTIONS }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context><cwd>/repo/my-app</cwd></environment_context>" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Turn 1 answer" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Turn 2 chay $e2e-codex-cli-test" }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: SAMPLE_SELECTED_SKILL }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["skills.selected_skill_instructions"],
          },
        },
      ],
    });
    const normTurn2 = CodexPayloadNormalizer.normalize(rawTurn2);
    const filtered = builder.filterHostSkills(normTurn2.availableSkills, settings);
    const availDigest = builder.computeAvailableSkillsDigest(filtered, settings);
    const selDigest = builder.computeSelectedSkillsDigest(normTurn2.selectedSkills, settings);

    const dirTurn2 = sessionStore.resolveTurnDirectives("conv-1", {
      isNewConversation: false,
      normalized: normTurn2,
      availableSkillsDigest: availDigest,
      selectedSkillsDigest: selDigest,
    });
    expect(dirTurn2.includeAvailableSkills).toBe(true);
    expect(dirTurn2.includeSelectedSkills).toBe(true);

    const compiledTurn2 = compiler.compile({
      normalized: normTurn2,
      isNewConversation: false,
      availableSkillsText: builder.buildAvailableSkillsSection(filtered),
      selectedSkillsText: builder.buildSelectedSkillsSection(normTurn2.selectedSkills, settings),
    });
    const idxSkill = compiledTurn2.finalPrompt.indexOf("[Skill được người dùng kích hoạt trực tiếp cho lượt này]:");
    const idxUser = compiledTurn2.finalPrompt.indexOf("[Yêu cầu hiện tại của mình]:");
    expect(idxSkill).toBeGreaterThan(-1);
    expect(idxUser).toBeGreaterThan(idxSkill);
    expect(compiledTurn2.finalPrompt).toContain("CODEX_WEB_TURN_TRACE=1 npm run launcher:start");

    sessionStore.commitTurnPrompt("conv-1", normTurn2, [], undefined, {
      availableSkillsDigest: availDigest,
      selectedSkillsDigest: selDigest,
    });

    // Bước tiếp theo trong cùng turn có tool_result: không gửi lại availableSkills và không lặp lại selectedSkill 4KB
    const rawToolContinuation = CodexRawPayload.from({
      model: "m365-copilot/gpt-5.6",
      stream: true,
      input: [
        ...(rawTurn2.input ?? []),
        {
          type: "function_call",
          call_id: "call_1",
          name: "exec_command",
          arguments: "{\"cmd\":\"pwd\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "/repo/my-app",
        },
      ],
    });
    const normToolCont = CodexPayloadNormalizer.normalize(rawToolContinuation);
    const dirToolCont = sessionStore.resolveTurnDirectives("conv-1", {
      isNewConversation: false,
      normalized: normToolCont,
      availableSkillsDigest: availDigest,
      selectedSkillsDigest: selDigest,
    });
    expect(dirToolCont.includeAvailableSkills).toBe(false);
    expect(dirToolCont.includeSelectedSkills).toBe(false);
  });

  test("SkillDirectoryScanner quét SKILL.md, parse frontmatter, tôn trọng allow_implicit_invocation và chống symlink loop", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-skills-scan-"));
    try {
      const customSkillDir = join(root, "deploy-helper");
      const hiddenSystemDir = join(root, ".system", "review-agent");
      const ignoredNodeModules = join(root, "node_modules", "fake-skill");
      mkdirSync(customSkillDir, { recursive: true });
      mkdirSync(join(hiddenSystemDir, "agents"), { recursive: true });
      mkdirSync(ignoredNodeModules, { recursive: true });

      writeFileSync(
        join(customSkillDir, "SKILL.md"),
        [
          "---",
          "name: deploy-helper",
          "description: >-",
          "  Trien khai nhanh ung dung",
          "  va kiem tra healthcheck.",
          "---",
          "",
          "# Deploy Helper",
          "Chay lenh bun run build.",
        ].join("\n"),
      );
      writeFileSync(
        join(hiddenSystemDir, "SKILL.md"),
        "---\nname: review-agent\ndescription: Review code\n---\nReview body",
      );
      writeFileSync(
        join(hiddenSystemDir, "agents", "openai.yaml"),
        "policy:\n  allow_implicit_invocation: false\n",
      );
      writeFileSync(
        join(ignoredNodeModules, "SKILL.md"),
        "---\nname: fake-skill\n---\nShould be ignored",
      );

      // Tạo symlink vòng về root để đảm bảo không bị lặp vô hạn
      symlinkSync(root, join(root, "loop-link"));

      const scanner = new SkillDirectoryScanner();
      const result = scanner.scanDirectories([{ path: root, enabled: true }]);

      expect(result.directories).toHaveLength(1);
      expect(result.directories[0]?.exists).toBe(true);
      expect(result.directories[0]?.skillCount).toBe(2);

      const deploy = result.skills.find((s) => s.name === "deploy-helper");
      expect(deploy).toBeDefined();
      expect(deploy?.source).toBe("custom");
      expect(deploy?.description).toBe("Trien khai nhanh ung dung va kiem tra healthcheck.");
      expect(deploy?.allowImplicitInvocation).toBe(true);

      const review = result.skills.find((s) => s.name === "review-agent");
      expect(review).toBeDefined();
      expect(review?.source).toBe("system");
      expect(review?.allowImplicitInvocation).toBe(false);
      expect(result.skills.some((s) => s.name === "fake-skill")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SkillPromptBuilder hợp nhất ưu tiên workspace > custom > system và tự nạp nội dung khi gõ $custom-skill", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-skills-mention-"));
    try {
      const skillDir = join(root, "my-custom-skill");
      const overrideDir = join(root, "e2e-codex-cli-test");
      mkdirSync(skillDir, { recursive: true });
      mkdirSync(overrideDir, { recursive: true });

      const customSkillFile = join(skillDir, "SKILL.md");
      writeFileSync(
        customSkillFile,
        "---\nname: my-custom-skill\ndescription: Custom workflow\n---\n# Huong dan custom\nBuoc 1: chay kiem tra.",
      );
      writeFileSync(
        join(overrideDir, "SKILL.md"),
        "---\nname: e2e-codex-cli-test\ndescription: Custom copy\n---\nCustom body",
      );

      const scanner = new SkillDirectoryScanner();
      const dirSkills = scanner.scanDirectories([{ path: root, enabled: true }]).skills;
      const hostSkills = CodexSkillParser.extractHostSkills(
        SAMPLE_SKILLS_INSTRUCTIONS,
        "/repo/my-app",
      );

      const builder = new SkillPromptBuilder();
      const settings = createDefaultSkillsSettings();
      const merged = builder.mergeSkills(hostSkills, dirSkills);

      // Workspace thắng Custom khi trùng tên e2e-codex-cli-test
      const e2eWinner = merged.find((s) => s.name === "e2e-codex-cli-test");
      expect(e2eWinner?.source).toBe("workspace");

      // Index vẫn giữ định dạng siêu gọn name -> path, không nhét description
      const filtered = builder.filterHostSkills(merged, settings);
      const indexSection = builder.buildAvailableSkillsSection(filtered);
      expect(indexSection).toContain(`- my-custom-skill -> ${customSkillFile}`);
      expect(indexSection).not.toContain("Custom workflow");

      // Khi user nhắc $my-custom-skill trong prompt, proxy tự đọc SKILL.md và tạo selectedSkill
      const resolvedSelected = builder.resolveExplicitSkillMentions(
        "Hay dung $my-custom-skill de kiem tra giup toi, gia $100",
        merged,
        [],
        settings,
      );
      expect(resolvedSelected).toHaveLength(1);
      expect(resolvedSelected[0]?.name).toBe("my-custom-skill");
      expect(resolvedSelected[0]?.path).toBe(customSkillFile);
      expect(resolvedSelected[0]?.body).toContain("Buoc 1: chay kiem tra.");

      const selectedSection = builder.buildSelectedSkillsSection(resolvedSelected, settings);
      expect(selectedSection).toContain("[Skill được người dùng kích hoạt trực tiếp cho lượt này]:");
      expect(selectedSection).toContain("Buoc 1: chay kiem tra.");

      // Khi skill bị tắt trong disabledSkills thì không tự nạp
      const disabledSelected = builder.resolveExplicitSkillMentions(
        "Hay dung $my-custom-skill",
        merged,
        [],
        { ...settings, disabledSkills: ["my-custom-skill"] },
      );
      expect(disabledSelected).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
