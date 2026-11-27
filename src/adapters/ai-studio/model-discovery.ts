import type { Page } from "playwright-core";
import type { DiscoveredModelEntry } from "../../models/types";
import { dismissAiStudioWelcomeDialogs } from "./ai-studio-human-timing";
import { AI_STUDIO_ORIGIN } from "./conversation-url";

export interface RawAiStudioDomModelItem {
  readonly remoteModelId?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly contextText?: string;
  readonly categoryText?: string;
}

const NON_CHAT_MODEL_PATTERN =
  /(?:\b(imagen|veo|lyria|tts|audio|native-audio|speech|embedding|aqa|robotics|live|bidi|music|video|image-generation|image generation|image editing|computer-use|nano[\s-]*banana)\b|-image(?:$|-))/i;

/** Phân tích chuỗi dung lượng ngữ cảnh (vd `"1M tokens"`, `"200k"`, `"1,048,576"`) thành số token chuẩn. */
export function parseAiStudioContextWindow(rawText?: string): number | undefined {
  if (!rawText) return undefined;
  if (/(?:input|output)\s*:\s*\$|all context lengths/i.test(rawText)) return undefined;
  const cleaned = rawText.replace(/,/g, "").trim();
  const millionMatch = /(\d+(?:\.\d+)?)\s*m\b/i.exec(cleaned);
  if (millionMatch) {
    const val = Math.round(Number(millionMatch[1]) * 1_000_000);
    return Number.isFinite(val) && val >= 4_096 ? val : undefined;
  }
  const thousandMatch = /(\d+(?:\.\d+)?)\s*k\b/i.exec(cleaned);
  if (thousandMatch) {
    const val = Math.round(Number(thousandMatch[1]) * 1_000);
    return Number.isFinite(val) && val >= 4_096 ? val : undefined;
  }
  const rawNumberMatch = /\b(\d{5,8})\b/.exec(cleaned);
  if (rawNumberMatch) {
    const val = Number(rawNumberMatch[1]);
    return Number.isFinite(val) && val >= 4_096 ? val : undefined;
  }
  return undefined;
}

/** Chuẩn hóa `remoteModelId` từ ID gốc hoặc từ tên hiển thị (vd `"Gemini 4 Hydrogen"` -> `"gemini-4-hydrogen"`). */
export function normalizeAiStudioRemoteModelId(
  rawId?: string,
  displayName?: string,
): string {
  const fromId = (rawId ?? "")
    .trim()
    .replace(/^models\//i, "")
    .replace(/^ai-studio\//i, "");
  if (fromId && /^[a-z0-9][a-z0-9._-]{2,}$/i.test(fromId)) {
    return fromId.toLowerCase();
  }
  const fromName = (displayName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return fromName;
}

/**
 * Chuẩn hóa & lọc danh sách model thô quét từ Google AI Studio (loại bỏ model tạo ảnh/video/TTS/embedding).
 */
export function buildAiStudioDiscoveredModels(
  rawItems: readonly RawAiStudioDomModelItem[],
): DiscoveredModelEntry[] {
  const results: DiscoveredModelEntry[] = [];
  const seen = new Set<string>();

  for (const item of rawItems) {
    const displayName = item.displayName.replace(/\s+/g, " ").trim();
    if (!displayName) continue;

    const remoteModelId = normalizeAiStudioRemoteModelId(item.remoteModelId, displayName);
    if (!remoteModelId) continue;

    const inspectTarget = `${remoteModelId} ${displayName} ${item.categoryText ?? ""} ${item.description ?? ""}`;
    if (NON_CHAT_MODEL_PATTERN.test(inspectTarget)) continue;

    const slug = `ai-studio/${remoteModelId}`;
    if (seen.has(slug)) continue;
    seen.add(slug);

    const contextWindow =
      parseAiStudioContextWindow(item.contextText) ??
      parseAiStudioContextWindow(item.description);

    results.push({
      slug,
      providerId: "ai-studio",
      displayName,
      remoteModelId,
      ...(item.description?.trim() ? { description: item.description.trim() } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      inputModalities: ["text", "image"],
      defaultReasoningLevel: "high",
    });
  }

  return results;
}

const MODEL_SELECTOR_TRIGGERS = [
  "ms-model-selector button.model-selector-card",
  "button.model-selector-card",
  "ms-model-selector button",
  "ms-model-selector",
].join(", ");

const MODEL_CAROUSEL_OPTIONS = [
  "ms-model-carousel .model-options-container button.content-button",
  "ms-model-carousel button.content-button",
  ".cdk-overlay-pane .model-list-container button.content-button",
  "ms-model-selector-modal [data-model-id]",
  '[role="listbox"] [role="option"]',
].join(", ");

/**
 * Logic Auto-Discovery quét trực tiếp các model chat khả dụng trên Google AI Studio (`aistudio.google.com`).
 */
export class AiStudioModelDiscovery {
  public async discoverModels(page: Page): Promise<DiscoveredModelEntry[]> {
    const currentUrl = typeof page.url === "function" ? page.url() : "";
    if (/accounts\.google\.com/i.test(currentUrl)) {
      throw new Error(
        "Google AI Studio session is signed out. Sign in with Chrome before refreshing models.",
      );
    }

    if (!currentUrl || !currentUrl.startsWith(AI_STUDIO_ORIGIN)) {
      await page.goto(`${AI_STUDIO_ORIGIN}/prompts/new_chat`, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
    }

    await page
      .locator('textarea[aria-label="Enter a prompt"], ms-model-selector, button.model-selector-card')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});

    const postUrl = typeof page.url === "function" ? page.url() : "";
    if (/accounts\.google\.com/i.test(postUrl)) {
      throw new Error(
        "Google AI Studio session is signed out. Sign in with Chrome before refreshing models.",
      );
    }

    await dismissAiStudioWelcomeDialogs(page);

    let openedPanel = false;
    try {
      const trigger = page.locator(MODEL_SELECTOR_TRIGGERS).first();
      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click({ timeout: 3_000 }).catch(() => {});
        openedPanel = true;
        await page
          .locator("ms-model-carousel, .cdk-overlay-pane .model-categories-container")
          .first()
          .waitFor({ state: "visible", timeout: 5_000 })
          .catch(() => {});

        // Chọn chip filter "Gemini" (hoặc fallback "All") để lấy đầy đủ danh sách model chat thay vì chỉ tab Featured.
        const geminiChip = page
          .locator(".model-categories-container button.ms-button-filter-chip")
          .filter({ hasText: /^Gemini$/i })
          .first();
        if (await geminiChip.isVisible().catch(() => false)) {
          await geminiChip.click({ timeout: 2_000 }).catch(() => {});
          await page.waitForTimeout(300);
        }

        await page
          .locator(MODEL_CAROUSEL_OPTIONS)
          .first()
          .waitFor({ state: "visible", timeout: 4_000 })
          .catch(() => {});
      }

      const rawItems = await page.evaluate((panelSel) => {
        const items: Array<{
          remoteModelId?: string;
          displayName: string;
          description?: string;
          contextText?: string;
          categoryText?: string;
        }> = [];

        const candidates = Array.from(document.querySelectorAll<HTMLElement>(panelSel));
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          const titleEl = el.querySelector<HTMLElement>(".model-title-text, h3, h4, strong");
          const subtitleEl = el.querySelector<HTMLElement>(".model-subtitle");
          const detailsEl = el.querySelector<HTMLElement>(".model-details");

          const dataModelId =
            el.getAttribute("data-model-id") ||
            el.getAttribute("data-value") ||
            subtitleEl?.innerText?.trim() ||
            undefined;

          const lines = (el.innerText || el.textContent || "")
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

          const idFromLine = lines.find(line =>
            /^(?:models\/)?(?:gemini|gemma|learnlm)-[a-z0-9._-]+$/i.test(line),
          );
          const remoteModelId = dataModelId || idFromLine;

          const displayName =
            titleEl?.innerText?.trim() ||
            lines.find(
              line =>
                line !== idFromLine &&
                !/^(spark|info|new|preview|free|paid|\d+[km]\s*tokens?)$/i.test(line),
            ) ||
            "";
          if (!displayName) continue;

          const rawDetails = detailsEl?.innerText?.trim() || "";
          const cleanDetailLines = rawDetails
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l && !/^(spark|info|attach_money|rocket_launch|learn more)$/i.test(l) && !/input:\s*\$|release date:/i.test(l) && !l.startsWith("gemini-"));
          const description = cleanDetailLines[0] ||
            lines.find(
              line =>
                line !== displayName &&
                line !== idFromLine &&
                line.length >= 16 &&
                !/input:\s*\$|release date:/i.test(line),
            );
          const contextText = lines.find(
            line =>
              !/input:\s*\$|output:\s*\$/i.test(line) &&
              (/\b\d+(?:\.\d+)?\s*[km]\b|\b\d[\d,]{4,}\s*tokens?\b/i.test(line)),
          );

          items.push({
            ...(remoteModelId ? { remoteModelId } : {}),
            displayName,
            ...(description ? { description } : {}),
            ...(contextText ? { contextText } : {}),
          });
        }

        // Fallback: lấy model đang chọn hiện tại trên URL hoặc trigger card nếu panel chưa mở được
        if (items.length === 0) {
          let urlModel = "";
          try {
            urlModel = new URL(location.href).searchParams.get("model") || "";
          } catch {}
          const triggerEl = document.querySelector<HTMLElement>(
            "ms-model-selector button.model-selector-card, button.model-selector-card",
          );
          const triggerLines = (triggerEl?.innerText || "")
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
          if (urlModel || triggerLines.length > 0) {
            items.push({
              ...(urlModel ? { remoteModelId: urlModel } : {}),
              displayName: triggerLines[0] || urlModel,
              contextText: triggerLines.find(l => /\d+[km]/i.test(l)),
            });
          }
        }

        return items;
      }, MODEL_CAROUSEL_OPTIONS);

      const discovered = buildAiStudioDiscoveredModels(rawItems);
      if (discovered.length === 0) {
        throw new Error(
          "Could not read any chat models from Google AI Studio selector. Ensure the page finished loading.",
        );
      }
      return discovered;
    } finally {
      if (openedPanel) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(100);
      }
    }
  }
}
