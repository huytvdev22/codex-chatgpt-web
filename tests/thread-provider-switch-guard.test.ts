import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { AdapterRegistry } from "../src/adapters/adapter-registry";
import type { ProviderAdapter } from "../src/adapters/base";
import {
  AiStudioBrowserWorker,
  AiStudioCapabilityPicker,
} from "../src/adapters/ai-studio";
import {
  ChatGptBrowserWorker,
  ChatGptCapabilityPicker,
} from "../src/adapters/chatgpt";
import {
  GeminiBrowserWorker,
  GeminiCapabilityPicker,
} from "../src/adapters/gemini";
import { M365BrowserWorker } from "../src/adapters/m365-copilot";
import { ModelRegistry } from "../src/models/model-registry";
import { ResponsesService } from "../src/services/responses-service";
import { ThreadProviderBindingStore } from "../src/services/thread-provider-binding-store";
import type { CodexParsedRequest } from "../src/types";

function makeThreadPayload(
  model: string,
  threadId: string,
  options: { stream?: boolean; reasoning?: string; text?: string } = {},
) {
  return {
    model,
    stream: options.stream ?? false,
    ...(options.reasoning ? { reasoning: { effort: options.reasoning } } : {}),
    client_metadata: {
      thread_id: threadId,
      turn_id: `turn_${Math.random().toString(36).slice(2, 8)}`,
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: options.text ?? "xin chào" }],
      },
    ],
  };
}

function makeTitlePayload(model: string, threadId: string) {
  return {
    model,
    stream: false,
    client_metadata: {
      thread_id: threadId,
      turn_id: "turn_title_1",
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.",
          },
        ],
      },
    ],
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        strict: true,
        name: "codex_output_schema",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
          },
          required: ["title", "description"],
          additionalProperties: false,
        },
      },
    },
  };
}

describe("ThreadProviderBindingStore", () => {
  test("lưu bền vững ra đĩa, nạp lại sau restart và evict theo LRU", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-binding-"));
    const filePath = join(dir, "thread-provider-bindings.json");
    try {
      const store1 = new ThreadProviderBindingStore({
        filePath,
        maxBindings: 2,
        debounceMs: 0,
      });

      expect(store1.bind("default", { providerId: "gemini", modelId: "gemini/4-hydrogen" })).toBeUndefined();
      store1.bind("thread-1", { providerId: "gemini", modelId: "gemini/4-hydrogen", reasoning: "medium" });
      store1.bind("thread-2", { providerId: "chatgpt", modelId: "chatgpt/gpt-6.2" });
      store1.bind("thread-3", { providerId: "ai-studio", modelId: "ai-studio/gemini-4-hydrogen" });

      // maxBindings=2 => thread-1 bị đẩy ra
      expect(store1.size).toBe(2);
      expect(store1.get("thread-1")).toBeUndefined();

      // Restart instance mới đọc từ đĩa
      const store2 = new ThreadProviderBindingStore({
        filePath,
        maxBindings: 2,
        debounceMs: 0,
      });
      expect(store2.get("thread-2")?.providerId).toBe("chatgpt");
      expect(store2.get("thread-3")?.providerId).toBe("ai-studio");

      // File JSON hỏng vẫn khởi tạo an toàn
      writeFileSync(filePath, "{broken-json", "utf8");
      const store3 = new ThreadProviderBindingStore({ filePath, debounceMs: 0 });
      expect(store3.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ResponsesService cross-provider guard & same-provider switching", () => {
  test("không khóa thread khi Turn 1 thất bại, chỉ khóa sau Turn 1 thành công và chặn HTTP 400 khi đổi khác provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "responses-guard-"));
    const filePath = join(dir, "thread-provider-bindings.json");
    try {
      const dispatched: Array<{ providerId: string; modelId: string; reasoning?: string }> = [];
      let failFirstChatGpt = true;

      const makeStub = (providerId: string): ProviderAdapter => ({
        name: providerId,
        async runTurn(parsed: CodexParsedRequest, _incoming, emit) {
          dispatched.push({
            providerId,
            modelId: parsed.modelId,
            reasoning: parsed.options.reasoning,
          });
          if (providerId === "chatgpt" && failFirstChatGpt) {
            failFirstChatGpt = false;
            emit({ type: "error", message: "[ChatGPT] chưa đăng nhập" });
            return;
          }
          emit({ type: "text_delta", text: "OK" });
          emit({ type: "done" });
        },
      });

      const adapterRegistry = new AdapterRegistry([
        ["chatgpt", () => makeStub("chatgpt")],
        ["gemini", () => makeStub("gemini")],
        ["m365-copilot", () => makeStub("m365-copilot")],
      ]);
      const bindingStore = new ThreadProviderBindingStore({ filePath, debounceMs: 0 });
      const service = new ResponsesService(
        ModelRegistry.getInstance(),
        adapterRegistry,
        () => undefined,
        bindingStore,
      );

      // 1. Turn 1 với chatgpt bị lỗi -> không khóa thread
      const resFail = await service.executeTurn({
        req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
        raw: makeThreadPayload("chatgpt/gpt-6.2", "thread-alpha"),
        requestedModel: "chatgpt/gpt-6.2",
        providerId: "chatgpt",
        options: { rememberState: false },
      });
      expect(resFail.status).toBe(200);
      const failBody = await resFail.json();
      expect(failBody.status).toBe("failed");
      expect(bindingStore.get("thread-alpha")).toBeUndefined();

      // 2. User chuyển sang gemini và thành công -> thread bị khóa vào gemini
      const resGemini1 = await service.executeTurn({
        req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
        raw: makeThreadPayload("gemini/4-hydrogen", "thread-alpha", { reasoning: "medium" }),
        requestedModel: "gemini/4-hydrogen",
        providerId: "gemini",
        options: { rememberState: false },
      });
      expect(resGemini1.status).toBe(200);
      expect(bindingStore.get("thread-alpha")).toMatchObject({
        providerId: "gemini",
        modelId: "gemini/4-hydrogen",
      });

      // 3. Đổi model & reasoning CÙNG provider (gemini/4-hydrogen -> gemini/4-neon, high) -> cho phép
      const resGemini2 = await service.executeTurn({
        req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
        raw: makeThreadPayload("gemini/4-neon", "thread-alpha", { reasoning: "high" }),
        requestedModel: "gemini/4-neon",
        providerId: "gemini",
        options: { rememberState: false },
      });
      expect(resGemini2.status).toBe(200);
      expect(bindingStore.get("thread-alpha")?.modelId).toBe("gemini/4-neon");

      // 4. Đổi sang KHÁC provider (chatgpt/gpt-6.2) -> chặn HTTP 400 (kể cả trên service mới khởi động lại)
      const restartedService = new ResponsesService(
        ModelRegistry.getInstance(),
        adapterRegistry,
        () => undefined,
        new ThreadProviderBindingStore({ filePath, debounceMs: 0 }),
      );
      const countBeforeBlock = dispatched.length;
      const resBlocked = await restartedService.executeTurn({
        req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
        raw: makeThreadPayload("chatgpt/gpt-6.2", "thread-alpha"),
        requestedModel: "chatgpt/gpt-6.2",
        providerId: "chatgpt",
        options: { rememberState: false },
      });
      expect(resBlocked.status).toBe(400);
      const errJson = await resBlocked.json();
      expect(errJson.error.type).toBe("invalid_request_error");
      expect(errJson.error.message).toContain("gemini");
      expect(errJson.error.message).toContain("chatgpt");
      expect(errJson.error.message).toContain("gemini/4-hydrogen");
      expect(errJson.error.message).toContain("gemini/4-neon");
      expect(dispatched.length).toBe(countBeforeBlock);

      // 5. Request sinh tiêu đề nền vẫn không bị chặn
      const resTitle = await restartedService.executeTurn({
        req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
        raw: makeTitlePayload("m365-copilot/gpt-5.6", "thread-alpha"),
        requestedModel: "m365-copilot/gpt-5.6",
        providerId: "m365-copilot",
        options: { rememberState: false },
      });
      expect(resTitle.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("khóa thread ở luồng SSE stream=true chỉ khi nhận được done thành công", async () => {
    const dir = mkdtempSync(join(tmpdir(), "responses-stream-guard-"));
    const filePath = join(dir, "thread-provider-bindings.json");
    try {
      const makeStub = (providerId: string): ProviderAdapter => ({
        name: providerId,
        async runTurn(_parsed, _incoming, emit) {
          emit({ type: "text_delta", text: "Hello SSE" });
          emit({ type: "done" });
        },
      });
      const adapterRegistry = new AdapterRegistry([
        ["gemini", () => makeStub("gemini")],
        ["chatgpt", () => makeStub("chatgpt")],
      ]);
      const bindingStore = new ThreadProviderBindingStore({ filePath, debounceMs: 0 });
      const service = new ResponsesService(
        ModelRegistry.getInstance(),
        adapterRegistry,
        () => undefined,
        bindingStore,
      );

      const res = await service.executeTurn({
        req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
        raw: makeThreadPayload("gemini/4-hydrogen", "thread-sse", { stream: true }),
        requestedModel: "gemini/4-hydrogen",
        providerId: "gemini",
        options: { rememberState: false },
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(bindingStore.get("thread-sse")?.providerId).toBe("gemini");

      const resBlocked = await service.executeTurn({
        req: new Request("http://127.0.0.1:17841/v1/responses", { method: "POST" }),
        raw: makeThreadPayload("chatgpt/gpt-6.2", "thread-sse", { stream: true }),
        requestedModel: "chatgpt/gpt-6.2",
        providerId: "chatgpt",
        options: { rememberState: false },
      });
      expect(resBlocked.status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CapabilityPicker fail-closed model switching across 4 adapters", () => {
  test("GeminiCapabilityPicker & GeminiBrowserWorker fail-closed khi model không tồn tại hoặc disabled, best-effort với thinking", async () => {
    const picker = new GeminiCapabilityPicker();
    let menuOpen = false;
    let selectedModel = "4 Hydrogen";
    let disabledNeon = false;

    const makeMenuItem = (label: string, checked: boolean, disabled = false) => ({
      isVisible: async () => menuOpen,
      innerText: async () => label,
      getAttribute: async (attr: string) => {
        if (attr === "aria-checked") return checked ? "true" : "false";
        if (attr === "aria-disabled") return disabled ? "true" : "false";
        return null;
      },
      isDisabled: async () => disabled,
      click: async () => {
        selectedModel = label;
        menuOpen = false;
      },
    });

    const fakePage = {
      url: () => "https://gemini.google.com/app/abc123",
      waitForTimeout: async () => {},
      keyboard: {
        press: async (key: string) => {
          if (key === "Escape") menuOpen = false;
        },
      },
      locator: (selector: string) => {
        if (selector.includes("bard-mode-menu-button")) {
          return {
            first: () => ({
              isVisible: async () => true,
              click: async () => {
                menuOpen = true;
              },
            }),
          };
        }
        if (selector.includes("thinking_level")) {
          return {
            first: () => ({
              isVisible: async () => false,
            }),
          };
        }
        if (selector.includes("menuitemradio")) {
          const items = [
            makeMenuItem("4 Hydrogen", selectedModel === "4 Hydrogen"),
            makeMenuItem("4 Neon", selectedModel === "4 Neon", disabledNeon),
          ];
          return {
            count: async () => items.length,
            nth: (index: number) => items[index]!,
          };
        }
        return {
          first: () => ({
            isVisible: async () => menuOpen,
            waitFor: async () => {},
            locator: (sub: string) => fakePage.locator(sub),
          }),
          last: () => ({
            isVisible: async () => false,
          }),
        };
      },
    } as unknown as Page;

    // 1. Đổi 4 Hydrogen -> 4 Neon thành công (dù không có thinking submenu vẫn modelSelected=true)
    const okSwitch = await picker.ensureCapabilityDetailed(fakePage, {
      modelSlug: "gemini/4-neon",
      modelLabel: "4 Neon",
      thinkingEffort: "high",
    });
    expect(okSwitch.modelSelected).toBe(true);
    expect(selectedModel).toBe("4 Neon");

    // 2. Khi model không tồn tại -> fail-closed
    const missingModel = await picker.ensureCapabilityDetailed(fakePage, {
      modelSlug: "gemini/non-existent",
      modelLabel: "4 Unknown",
      thinkingEffort: "medium",
    });
    expect(missingModel.modelSelected).toBe(false);

    // 3. Khi model bị disabled -> fail-closed
    selectedModel = "4 Hydrogen";
    disabledNeon = true;
    picker.clearCache(fakePage);
    const disabledResult = await picker.ensureCapabilityDetailed(fakePage, {
      modelSlug: "gemini/4-neon",
      modelLabel: "4 Neon",
      thinkingEffort: "high",
    });
    expect(disabledResult.modelSelected).toBe(false);
    expect(disabledResult.reason).toContain("khóa");

    // 4. GeminiBrowserWorker.prepareProvider ném lỗi khi modelSelected=false
    const worker = new GeminiBrowserWorker();
    const workerHelper = worker as unknown as {
      prepareProvider: (p: Page, o: Record<string, unknown>) => Promise<void>;
      clipboardSalvage: { setupHook: (p: Page) => Promise<void> };
      waitForVisibleComposer: (p: Page, t: number) => Promise<void>;
      waitForComposerIdle: (p: Page) => Promise<void>;
    };
    workerHelper.clipboardSalvage = { setupHook: async () => {} };
    workerHelper.waitForVisibleComposer = async () => {};
    workerHelper.waitForComposerIdle = async () => {};

    const noTriggerPage = {
      url: () => "https://gemini.google.com/app/abc123",
      locator: () => ({
        first: () => ({ isVisible: async () => false }),
      }),
    } as unknown as Page;

    await expect(
      workerHelper.prepareProvider(noTriggerPage, {
        modelSlug: "gemini/4-neon",
        reasoning: "high",
      }),
    ).rejects.toThrow(/Không thể chuyển sang model/);
  });

  test("ChatGptCapabilityPicker fail-closed khi yêu cầu model non-default trên tài khoản không có switcher", async () => {
    const picker = new ChatGptCapabilityPicker();
    const freePlanPage = {
      waitForTimeout: async () => {},
      locator: () => ({
        first: () => ({ isVisible: async () => false }),
        count: async () => 0,
      }),
    } as unknown as Page;

    const failNonDefault = await picker.ensureCapabilityDetailed(freePlanPage, {
      modelSlug: "chatgpt/gpt-6",
      modelLabel: "GPT-6",
      shortUiVersion: "6",
      isAccountDefault: false,
      thinkingEffort: "medium",
    });
    expect(failNonDefault.modelSelected).toBe(false);

    const worker = new ChatGptBrowserWorker();
    const helper = worker as unknown as {
      prepareProvider: (p: Page, o: Record<string, unknown>) => Promise<void>;
      clipboardSalvage: { setupHook: (p: Page) => Promise<void> };
      waitForVisibleComposer: (p: Page, t: number) => Promise<void>;
      waitForComposerIdle: (p: Page) => Promise<void>;
    };
    helper.clipboardSalvage = { setupHook: async () => {} };
    helper.waitForVisibleComposer = async () => {};
    helper.waitForComposerIdle = async () => {};

    await expect(
      helper.prepareProvider(
        {
          url: () => "https://chatgpt.com/c/6afae1f3-e4f0-83ec-8aca-7c8649cfde1c",
          locator: () => ({
            first: () => ({ isVisible: async () => false }),
            count: async () => 0,
          }),
        } as unknown as Page,
        { modelSlug: "chatgpt/gpt-6", reasoning: "medium" },
      ),
    ).rejects.toThrow(/Không thể chuyển sang model/);
  });

  test("AiStudioCapabilityPicker đổi model ngay trên URL /prompts/{id} đang mở và fail-closed nếu model không có", async () => {
    const picker = new AiStudioCapabilityPicker();
    let currentModelId = "gemini-4-hydrogen";
    let panelOpen = false;

    const fakePage = {
      url: () => "https://aistudio.google.com/prompts/1f4VKkbKG5PxctRMKVZN4bR3TRBcc1ROb",
      waitForTimeout: async () => {},
      keyboard: {
        press: async (key: string) => {
          if (key === "Escape") panelOpen = false;
        },
      },
      evaluate: async (_fn: unknown, arg?: { targetId?: string }) => {
        return arg?.targetId === currentModelId;
      },
      locator: (selector: string) => {
        if (selector.includes("model-selector-card") || selector === "ms-model-selector button") {
          return {
            first: () => ({
              isVisible: async () => true,
              click: async () => {
                panelOpen = true;
              },
            }),
          };
        }
        if (selector.includes("ms-button-filter-chip")) {
          return {
            filter: () => ({
              first: () => ({
                isVisible: async () => false,
              }),
            }),
          };
        }
        if (selector.includes("ms-model-carousel")) {
          const items = [
            { id: "gemini-4-hydrogen", text: "Gemini 4 Hydrogen" },
            { id: "gemini-4-neon", text: "Gemini 4 Neon" },
          ];
          return {
            first: () => ({
              waitFor: async () => {},
            }),
            count: async () => items.length,
            nth: (index: number) => ({
              isVisible: async () => panelOpen,
              getAttribute: async (attr: string) =>
                attr === "data-model-id" ? items[index]!.id : null,
              isDisabled: async () => false,
              innerText: async () => items[index]!.text,
              click: async () => {
                currentModelId = items[index]!.id;
                panelOpen = false;
              },
            }),
          };
        }
        return {
          first: () => ({
            isVisible: async () => false,
            waitFor: async () => {},
          }),
        };
      },
    } as unknown as Page;

    const ok = await picker.ensureCapabilityDetailed(fakePage, {
      modelSlug: "ai-studio/gemini-4-neon",
      remoteModelId: "gemini-4-neon",
      displayName: "Gemini 4 Neon",
      thinkingLevel: "High",
    });
    expect(ok.modelSelected).toBe(true);
    expect(currentModelId).toBe("gemini-4-neon");

    const missing = await picker.ensureCapabilityDetailed(fakePage, {
      modelSlug: "ai-studio/gemini-missing",
      remoteModelId: "gemini-missing",
      displayName: "Gemini Missing",
      thinkingLevel: "High",
    });
    expect(missing.modelSelected).toBe(false);

    const worker = new AiStudioBrowserWorker();
    const helper = worker as unknown as {
      prepareProvider: (p: Page, o: Record<string, unknown>) => Promise<void>;
      waitForVisibleComposer: (p: Page, t: number) => Promise<void>;
      dismissObstructingNudges: (p: Page) => Promise<void>;
    };
    helper.waitForVisibleComposer = async () => {};
    helper.dismissObstructingNudges = async () => {};
    await expect(
      helper.prepareProvider(fakePage, {
        modelSlug: "ai-studio/gemini-missing",
        reasoning: "high",
      }),
    ).rejects.toThrow(/Không thể chuyển sang model/);
  });

  test("M365BrowserWorker.prepareProvider fail-closed khi không chuyển được model/mode cụ thể", async () => {
    const worker = new M365BrowserWorker();
    const helper = worker as unknown as {
      prepareProvider: (p: Page, o: Record<string, unknown>) => Promise<void>;
    };
    const brokenPickerPage = {
      waitForSelector: async () => {},
      waitForTimeout: async () => {},
      keyboard: { press: async () => {} },
      evaluate: async () => false,
    } as unknown as Page;

    await expect(
      helper.prepareProvider(brokenPickerPage, {
        modelSlug: "m365-copilot/gpt-5.6",
        reasoning: "high",
      }),
    ).rejects.toThrow(/Không thể chuyển sang model/);
  });
});
