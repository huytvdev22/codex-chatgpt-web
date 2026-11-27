import { describe, expect, test } from "bun:test";
import { buildAiStudioDiscoveredModels, parseAiStudioContextWindow } from "../src/adapters/ai-studio";
import {
  buildChatGptDiscoveredModels,
  normalizeChatGptSlugFromLabel,
} from "../src/adapters/chatgpt";
import { buildGeminiDiscoveredModels } from "../src/adapters/gemini";
import {
  buildM365DiscoveredModels,
  M365ModelProvider,
} from "../src/adapters/m365-copilot";

describe("Adapter Model Discovery Parsers", () => {
  test("AI Studio: lọc model non-chat (Imagen/Veo/TTS/Embedding) và parse context window", () => {
    expect(parseAiStudioContextWindow("1M tokens")).toBe(1_000_000);
    expect(parseAiStudioContextWindow("2.5M context")).toBe(2_500_000);
    expect(parseAiStudioContextWindow("128K tokens")).toBe(128_000);

    const models = buildAiStudioDiscoveredModels([
      {
        remoteModelId: "models/gemini-4-hydrogen",
        displayName: "Gemini 4 Hydrogen",
        contextText: "1M tokens",
      },
      {
        remoteModelId: "gemini-4-neon",
        displayName: "Gemini 4 Neon",
        contextText: "2M tokens",
      },
      {
        remoteModelId: "imagen-4.0-generate",
        displayName: "Imagen 4",
        categoryText: "Image generation",
      },
      {
        remoteModelId: "veo-3.0-generate",
        displayName: "Veo 3",
      },
      {
        remoteModelId: "gemini-3-pro-image",
        displayName: "Nano Banana Pro",
        description: "State-of-the-art image generation and editing model.",
      },
      {
        remoteModelId: "gemini-2.5-flash-preview-tts",
        displayName: "Gemini 2.5 Flash TTS",
      },
      {
        remoteModelId: "text-embedding-005",
        displayName: "Text Embedding",
      },
    ]);

    expect(models.map(m => m.slug)).toEqual([
      "ai-studio/gemini-4-hydrogen",
      "ai-studio/gemini-4-neon",
    ]);
    expect(models[1]).toMatchObject({
      remoteModelId: "gemini-4-neon",
      contextWindow: 2_000_000,
    });
  });

  test("ChatGPT: chuẩn hóa uiLabel thành slug built-in và model mới giữ shortUiVersion", () => {
    expect(normalizeChatGptSlugFromLabel("GPT-6.2")).toBe("chatgpt/gpt-6.2");
    expect(normalizeChatGptSlugFromLabel("GPT-6")).toBe("chatgpt/gpt-6");
    expect(normalizeChatGptSlugFromLabel("GPT-5.6 Sol")).toBe("chatgpt/gpt-5.6-sol");
    expect(normalizeChatGptSlugFromLabel("GPT-6.5 Mini")).toBe("chatgpt/gpt-6.5-mini");

    const models = buildChatGptDiscoveredModels([
      { uiLabel: "GPT-6.2", isAccountDefault: true },
      { uiLabel: "GPT-6" },
      { uiLabel: "GPT-5.6 Sol" },
      { uiLabel: "o4-mini" },
    ]);

    expect(models.map(m => m.slug)).toEqual([
      "chatgpt/gpt-6.2",
      "chatgpt/gpt-6",
      "chatgpt/gpt-5.6-sol",
      "chatgpt/o4-mini",
    ]);
    expect(models[1].shortUiVersion).toBe("6");
    expect(models[2].shortUiVersion).toBe("5.6");
  });

  test("M365 Copilot: gom cặp Quick/Think thành 1 model và build capability spec động cho model mới", () => {
    const models = buildM365DiscoveredModels([
      { label: "Auto", itemTestId: "gptSubMenuModelTrigger-Magic", iconTestId: "checkmark-Magic" },
      { label: "Quick response", itemTestId: "gptSubMenuModelTrigger-Chat", iconTestId: "checkmark-Chat" },
      { label: "Think deeper", itemTestId: "gptSubMenuModelTrigger-Reasoning", iconTestId: "checkmark-Reasoning" },
      {
        label: "GPT-5.6 Sol Quick response",
        itemTestId: "gptSubMenuModelTrigger-OpenAI",
        iconTestId: "checkmark-Gpt_5_6_Chat",
        isSubmenu: true,
        parentMenuTestId: "gptSubMenuModelTrigger-OpenAI",
        parentLabel: "GPT",
      },
      {
        label: "GPT-5.6 Sol Think deeper",
        itemTestId: "gptSubMenuModelTrigger-OpenAI",
        iconTestId: "checkmark-Gpt_5_6_Reasoning",
        isSubmenu: true,
        parentMenuTestId: "gptSubMenuModelTrigger-OpenAI",
        parentLabel: "GPT",
      },
      {
        label: "GPT-6.2 Quick response",
        itemTestId: "gptSubMenuModelTrigger-OpenAI",
        iconTestId: "checkmark-Gpt_6_2_Chat",
        isSubmenu: true,
        parentMenuTestId: "gptSubMenuModelTrigger-OpenAI",
        parentLabel: "GPT",
      },
      {
        label: "GPT-6.2 Think deeper",
        itemTestId: "gptSubMenuModelTrigger-OpenAI",
        iconTestId: "checkmark-Gpt_6_2_Reasoning",
        isSubmenu: true,
        parentMenuTestId: "gptSubMenuModelTrigger-OpenAI",
        parentLabel: "GPT",
      },
    ]);

    expect(models.map(m => m.slug)).toEqual([
      "m365-copilot/gpt-5.6",
      "m365-copilot/gpt-6.2",
      "m365-copilot",
    ]);

    const discoveredGpt62 = models.find(m => m.slug === "m365-copilot/gpt-6.2")!;
    expect(discoveredGpt62.capabilityMeta).toMatchObject({
      quickLabel: "GPT-6.2 Quick response",
      thinkLabel: "GPT-6.2 Think deeper",
      quickIconTestId: "checkmark-Gpt_6_2_Chat",
      thinkIconTestId: "checkmark-Gpt_6_2_Reasoning",
      isSubmenu: true,
      parentMenuTestId: "gptSubMenuModelTrigger-OpenAI",
    });

    const route = M365ModelProvider.getInstance().buildRouteFromDiscovered(discoveredGpt62);
    expect(route?.capabilityMeta?.thinkIconTestId).toBe("checkmark-Gpt_6_2_Reasoning");
  });

  test("Gemini: chuẩn hóa Mode Picker (Auto / 4 Hydrogen / 4 Neon) và mode cổ điển (Fast / Thinking / Pro)", () => {
    const newUiModels = buildGeminiDiscoveredModels(
      [
        { label: "Auto", sublabel: "Adapts to your needs", modeId: "8c46e95b1a07cecc", isChecked: false },
        { label: "Everyday help", sublabel: "4 Hydrogen", modeId: "56fdd199312815e2", isChecked: true },
        { label: "Deeper analysis", sublabel: "4 Neon New", modeId: "e6fa609c3fa255c0", isChecked: false },
      ],
      true,
    );
    expect(newUiModels.map(m => m.slug)).toEqual([
      "gemini/auto",
      "gemini/4-hydrogen",
      "gemini/4-neon",
    ]);
    expect(newUiModels[1]).toMatchObject({
      slug: "gemini/4-hydrogen",
      uiLabel: "4 Hydrogen",
      remoteModelId: "56fdd199312815e2",
      isAccountDefault: true,
    });
    expect(newUiModels[2]).toMatchObject({
      slug: "gemini/4-neon",
      uiLabel: "4 Neon",
      remoteModelId: "e6fa609c3fa255c0",
      isAccountDefault: false,
    });

    const legacyUiModels = buildGeminiDiscoveredModels(
      [
        { label: "Fast", modeId: "fast" },
        { label: "Thinking", modeId: "thinking", isChecked: true },
        { label: "Pro", modeId: "pro" },
      ],
      false,
    );
    expect(legacyUiModels.map(m => m.slug)).toEqual(["gemini/4-hydrogen"]);

    const viUiModels = buildGeminiDiscoveredModels(
      [
        { label: "Tự động", sublabel: "Thích ứng với nhu cầu của bạn", modeId: "8c46e95b1a07cecc", isChecked: false },
        { label: "Trợ giúp hằng ngày", sublabel: "4 Hydrogen", modeId: "56fdd199312815e2", isChecked: true },
        { label: "Phân tích sâu hơn", sublabel: "4 Neon", modeId: "e6fa609c3fa255c0", isChecked: false },
      ],
      true,
    );
    expect(viUiModels.map(m => m.slug)).toEqual([
      "gemini/auto",
      "gemini/4-hydrogen",
      "gemini/4-neon",
    ]);
  });
});
