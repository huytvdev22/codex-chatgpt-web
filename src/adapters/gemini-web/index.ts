import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { geminiBrowserWorker } from "./gemini-browser-worker";
import { type GeminiDomSelectors } from "./selectors";
import { resolveGeminiReasoningEffort } from "../../models/model-registry";
import { LocalBrowserRuntime } from "../web/local-browser-runtime";
import { WebProviderAdapter } from "../web/web-provider-adapter";

export interface GeminiAdapterOptions {
  userDataDir?: string;
  customSelectors?: Partial<GeminiDomSelectors>;
  headless?: boolean;
  descriptorPath?: string;
  maxFormatRetries?: number;
}

export class GeminiWebAdapter extends WebProviderAdapter {
  override readonly name = "gemini-web";
  private options: GeminiAdapterOptions;

  constructor(options?: GeminiAdapterOptions) {
    const resolvedOptions: GeminiAdapterOptions = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-gemini-web"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    const localBrowser = new LocalBrowserRuntime({
      profileDir: resolvedOptions.userDataDir!,
      headless: resolvedOptions.headless,
      logPrefix: "gemini-adapter",
    });

    super(
      {
        id: "gemini-web",
        assistantName: "Gemini",
        logPrefix: "gemini-adapter",
        abortMessage: "Gemini turn aborted before start",
        policies: {
          launcherFailureMode: "fallback-local",
          emitErrorEventOnFailure: true,
          rethrowError: true,
          maxFormatRetries: resolvedOptions.maxFormatRetries ?? 2,
        },
        conversation: {
          resolveConversationKey: ({ threadId }) =>
            createHash("sha256")
              .update(`gemini-web:${threadId || "default-session"}`, "utf8")
              .digest("hex"),
        },
        capability: {
          resolveReasoningEffort: parsed =>
            resolveGeminiReasoningEffort(parsed.modelId, parsed.options.reasoning),
        },
        browser: {
          descriptorPath: resolvedOptions.descriptorPath,
          launcherProviderId: "gemini",
          connectorIdentity: "gemini-web",
          resolveSurfaceId: (descriptor, leaseSurfaceId) =>
            leaseSurfaceId || descriptor.geminiSurfaceId || descriptor.surfaceId,
          executeTurn: async ({
            page,
            prompt,
            attempt,
            parsed,
            incoming,
            reasoningEffort,
          }) => {
            if (!page) {
              throw new Error(
                "[gemini-adapter] Không có trình duyệt khả dụng để thực thi lượt.",
              );
            }
            const maxRetries = resolvedOptions.maxFormatRetries ?? 2;
            console.log(
              `[gemini-adapter] Thực thi lượt (lần thử ${attempt + 1}/${maxRetries + 1})...`,
            );
            return geminiBrowserWorker.executeTurn(page, {
              prompt,
              signal: incoming.abortSignal,
              modelSlug: parsed.modelId,
              reasoningEffort: reasoningEffort as
                | "low"
                | "medium"
                | "high"
                | undefined,
              customSelectors: resolvedOptions.customSelectors,
              // Quarantine: không emit chunk trực tiếp ra Codex trong lúc stream để tránh leak protocol XML
              onChunk: () => {},
            });
          },
        },
        response: {
          createCallId: () =>
            `call_gemini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        },
      },
      localBrowser,
    );

    this.options = resolvedOptions;
  }
}

export function createGeminiWebAdapter(
  options?: GeminiAdapterOptions,
): GeminiWebAdapter {
  return new GeminiWebAdapter(options);
}

export * from "./selectors";
export * from "./gemini-browser-worker";
