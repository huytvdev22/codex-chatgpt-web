import { describe, expect, test } from "bun:test";
import path from "node:path";
import { M365BrowserWorker } from "../src/adapters/m365-copilot/m365-browser-worker";

const workerPath = path.resolve(
  process.cwd(),
  "src/adapters/m365-copilot/m365-browser-worker.ts",
);
const observerPath = path.resolve(
  process.cwd(),
  "src/adapters/m365-copilot/m365-dom-observer.ts",
);

async function readWorkerSource(): Promise<string> {
  return (await Bun.file(workerPath).text()).replace(/\r\n/g, "\n");
}

async function readObserverSource(): Promise<string> {
  return (await Bun.file(observerPath).text()).replace(/\r\n/g, "\n");
}

describe("M365 browser worker migration contract", () => {
  test("submit chỉ thao tác trên editor và Send control đang hiển thị", async () => {
    const source = await readWorkerSource();

    expect(source).toContain("private async findVisibleLocator(");
    expect(source).toContain(
      "await this.findVisibleLocator(\n      page,\n      M365_CHAT_EDITOR_SELECTOR,",
    );
    expect(source).toContain(
      "await this.findVisibleLocator(\n        page,\n        CHAT_SELECTORS.sendButton,",
    );
    expect(source).toContain(
      "await this.findVisibleLocator(\n      page,\n      CHAT_SELECTORS.stopButton,",
    );
  });

  test("submit không phát synthetic pointer events hoặc requestSubmit", async () => {
    const source = await readWorkerSource();
    const executeTurnStart = source.indexOf("public async executeTurn(");
    const pollingStart = source.indexOf(
      "// 5. Polling theo dõi luồng sinh phản hồi",
      executeTurnStart,
    );
    const submitSection = source.slice(executeTurnStart, pollingStart);

    expect(submitSection).not.toContain("new PointerEvent(");
    expect(submitSection).not.toContain("new MouseEvent(");
    expect(submitSection).not.toContain(".requestSubmit(");
    expect(submitSection).not.toContain('keyboard.press("Enter")');
    expect(submitSection).not.toContain('keyboard.press("Control+Enter")');
    expect(submitSection).not.toContain("force: true");
  });

  test("submit fail-fast nếu editor visible vẫn còn nội dung", async () => {
    const source = await readWorkerSource();

    expect(source).toContain("if (!promptSubmitted) {");
    expect(source).toContain(
      "Không thể xác nhận prompt đã được gửi sau 10 lần thử",
    );
    expect(source).toContain("editorLength=${remainingText.length}");
  });

  test("retained conversation validation tiếp tục fail-closed", async () => {
    const source = await readWorkerSource();

    expect(source).toContain("M365 retained conversation mismatch");
    expect(source).toContain(
      "Launcher reused an unbound M365 surface that already contains a conversation",
    );
    expect(source).toMatch(
      /currentConversationId\s*!==\s*options\.existingConversationId\.toLowerCase\(\)/,
    );
  });

  test("attachment vẫn chạy trước prompt insertion", async () => {
    const source = await readWorkerSource();
    const attachmentIndex = source.indexOf("attachFilesViaPlusMenu(");
    const visibleEditorIndex = source.indexOf(
      "const editorLocator = await this.findVisibleLocator(",
    );

    expect(attachmentIndex).toBeGreaterThan(-1);
    expect(visibleEditorIndex).toBeGreaterThan(attachmentIndex);
  });

  test("worker kế thừa shared base, DOM observer và copy salvage đã được tách", async () => {
    const source = await readWorkerSource();

    expect(source).toContain(
      "export class M365BrowserWorker extends BaseWebBrowserWorker",
    );
    expect(source).toContain("private readonly domObserver = new M365DomObserver();");
    expect(source).toContain("private readonly clipboardSalvage = new M365ClipboardSalvage();");
    expect(source).toContain("protected override async beforeObserveResponse(");
    expect(source).toContain("protected async observeResponse(");
    expect(source).toContain("protected override shouldEnforceIdleTimeout(");
    expect(source).toContain("protected override onWaitTimeout(");
    expect(source).toContain("protected async extractCompletedResponse(");
    expect(source).not.toContain("protected async waitForCompletion(");
    expect(source).not.toContain("public async executeTurn(");
  });

  test("M365 polling dùng shared BaseWebBrowserWorker.waitForCompletion và runtime state tách riêng", async () => {
    const source = await readWorkerSource();

    expect(source).not.toContain("protected async waitForCompletion(");
    expect(source).not.toContain("public async executeTurn(");
    expect(source).toContain("protected async initializeTurnState(");
    expect(source).toContain("protected async cleanupTurnState(");
    expect(source).toContain("protected async handleExecutionError(");
    expect(source).toContain(
      "this.responseStates.set(page, this.createResponseRuntimeState());",
    );
    expect(source).toContain("this.clearTurnRuntimeState(page);");
    expect(source).toContain("this.domObserver.captureStatus(");
    expect(source).toContain("this.domObserver.applyStatus(");
    expect(source).toContain("this.clipboardSalvage.tryExtractCodeViaCopyButton(");
  });

  test("response runtime state gom đủ dữ liệu để tách observeResponse và extraction", async () => {
    const [workerSource, observerSource] = await Promise.all([
      readWorkerSource(),
      readObserverSource(),
    ]);

    expect(observerSource).toContain("export interface M365ResponseRuntimeState {");
    expect(observerSource).toContain(
      "markdownBuffer: SemanticMarkdownBuffer;",
    );
    expect(observerSource).toContain("fastPathBuffer: FastPathStreamBuffer;");
    expect(observerSource).toContain("lastFastPathText: string;");
    expect(observerSource).toContain("lastBlocks: SemanticMarkdownBlock[];");
    expect(observerSource).toContain("lastStatus: M365ResponseDomStatus | null;");
    expect(workerSource).toContain(
      "private readonly responseStates = new WeakMap<",
    );
  });

  test("shared lifecycle dùng timeout profile tương thích với M365 polling cũ", async () => {
    const source = await readWorkerSource();

    expect(source).toContain(
      "protected readonly defaultHardTimeoutMs = 20 * 60_000;",
    );
    expect(source).toContain(
      "protected readonly defaultIdleTimeoutMs = 30_000;",
    );
    expect(source).toContain(
      "protected readonly defaultPollingIntervalMs = 250;",
    );
    expect(source).toContain(
      "protected readonly defaultHeartbeatIntervalMs = 10_000;",
    );
    expect(source).toContain(
      'throw new Error("M365 multi-surface requires a stable conversation key");',
    );
  });

  test("M365 semantic buffers giữ ownership streaming delta khi chuyển sang shared lifecycle", async () => {
    const [workerSource, observerSource] = await Promise.all([
      readWorkerSource(),
      readObserverSource(),
    ]);

    expect(workerSource).toContain("protected shouldEmitObservationDelta(");
    expect(workerSource).toContain(
      "SemanticMarkdownBuffer và FastPathStreamBuffer đã phát semantic delta",
    );
    expect(workerSource).toContain("return false;");
    expect(observerSource).toContain(
      "const delta = responseState.fastPathBuffer.observe(",
    );
    expect(observerSource).toContain(
      "const delta = responseState.markdownBuffer.observe(",
    );
  });

  test("M365BrowserWorker thực thi polling qua BaseWebBrowserWorker.waitForCompletion và gọi heartbeat", async () => {
    let heartbeatCalls = 0;
    let pollCalls = 0;

    class TestM365BrowserWorker extends M365BrowserWorker {
      protected override async navigate(): Promise<void> {}
      protected override async prepareProvider(): Promise<void> {}
      protected override async captureResponseBaseline() {
        return { aiCount: 0, count: 0, lastText: "", lastHtml: "" };
      }
      protected override async insertPrompt(): Promise<void> {}
      protected override async submitPrompt(): Promise<void> {}
      protected override async stopGeneration(): Promise<boolean> {
        return true;
      }
      protected override async resolveConversationId(): Promise<string> {
        return "conv-heartbeat-1";
      }
      protected override shouldDelayFirstObservation(): boolean {
        return false;
      }
    }

    const worker = new TestM365BrowserWorker();
    (worker as any).domObserver = {
      createRuntimeState: () => ({
        markdownBuffer: { observe: () => "", finish: () => ({ markdown: "", delta: "" }) },
        fastPathBuffer: { observe: () => "", finish: () => ({ markdown: "", delta: "" }), getText: () => "" },
        fastPathActive: false,
        lastFastPathText: "",
        seenGenerating: false,
        hasSeenGenerating: false,
        completedCandidateAt: null,
        stableCycles: 0,
        lastTextChangeAt: Date.now(),
        lastBlocks: [],
        attempts: 0,
        lastStatus: null,
        pendingStatus: null,
      }),
      captureStatus: async () => ({
        isGenerating: pollCalls === 0,
        blocks: [{ key: "p::hi#1", tag: "p", html: "<p>Hello</p>", text: "Hello", streamable: false }],
        isNew: true,
        hasContent: true,
        detectedWebError: "",
        fastPathRawText: null,
        isInputActionsIdle: pollCalls > 0,
      }),
      applyStatus: async (_page: any, state: any, status: any) => {
        pollCalls += 1;
        state.lastBlocks = status.blocks;
        state.lastStatus = status;
        return {
          text: "Hello",
          isGenerating: status.isGenerating,
          isCompleted: pollCalls >= 2,
          activityKey: `poll-${pollCalls}`,
          status,
          blocks: status.blocks,
          fastPathActive: false,
          timedOut: false,
        };
      },
    };
    (worker as any).clipboardSalvage = {
      tryExtractCodeViaCopyButton: async () => null,
    };

    const fakePage: any = {
      url: () => "https://m365.cloud.microsoft/chat/conversation/conv-heartbeat-1",
      waitForTimeout: async () => {},
      locator: () => ({ count: async () => 0 }),
    };

    const result = await worker.executeTurn(fakePage, {
      prompt: "hello",
      conversationKey: "conv-heartbeat-1",
      pollingIntervalMs: 1,
      heartbeatIntervalMs: 5,
      idleTimeoutMs: 5_000,
      hardTimeoutMs: 10_000,
      heartbeat: async () => {
        heartbeatCalls += 1;
      },
    });

    expect(result.conversationId).toBe("conv-heartbeat-1");
    expect(result.rawResponse).toBe("Hello");
    expect(pollCalls).toBe(2);
    expect(heartbeatCalls).toBeGreaterThanOrEqual(1);
  });

  test("submitPrompt fallback sang scrollIntoView + page.mouse.click khi sendLocator.click lỗi viewport", async () => {
    class TestSubmitWorker extends M365BrowserWorker {
      public async testSubmit(page: any, options: any): Promise<void> {
        await this.submitPrompt(page, options);
      }
    }

    const worker = new TestSubmitWorker();
    let submitted = false;
    let mouseClickedAt: { x: number; y: number } | null = null;
    let scrolledIntoView = false;
    let evaluateTimeout: number | undefined;
    let boundingBoxTimeouts: Array<number | undefined> = [];
    let heartbeatCalls = 0;

    const editorLocator = {
      isVisible: async () => true,
      boundingBox: async () => ({ x: 100, y: 500, width: 400, height: 40 }),
      textContent: async () => (submitted ? "" : "hello world"),
    };
    const sendLocator = {
      isVisible: async () => true,
      isEnabled: async () => true,
      boundingBox: async (opts?: { timeout?: number }) => {
        boundingBoxTimeouts.push(opts?.timeout);
        return { x: 700, y: 760, width: 32, height: 32 };
      },
      click: async () => {
        throw new Error("TimeoutError: click: Timeout 1000ms exceeded. element is outside of the viewport");
      },
      evaluate: async (_fn: unknown, _arg: unknown, opts?: { timeout?: number }) => {
        evaluateTimeout = opts?.timeout;
        scrolledIntoView = true;
      },
    };

    const fakePage: any = {
      waitForTimeout: async () => {},
      mouse: {
        click: async (x: number, y: number) => {
          mouseClickedAt = { x, y };
          submitted = true;
        },
      },
      locator: (selector: string) => {
        if (selector.includes("Stop generating")) {
          return { count: async () => 0 };
        }
        if (selector.includes('aria-label="Send"')) {
          return { count: async () => 1, nth: () => sendLocator };
        }
        return { count: async () => 1, nth: () => editorLocator };
      },
    };

    await worker.testSubmit(fakePage, {
      prompt: "hello world",
      heartbeat: async () => {
        heartbeatCalls += 1;
      },
    });
    expect(scrolledIntoView).toBe(true);
    expect(evaluateTimeout).toBe(1_000);
    expect(boundingBoxTimeouts).toEqual([1_000, 1_000]);
    expect(heartbeatCalls).toBeGreaterThanOrEqual(1);
    expect(mouseClickedAt as { x: number; y: number } | null).toEqual({ x: 716, y: 776 });
  });

  test("submitPrompt thoát ngay không chạy fallback 30s nếu click đã kích hoạt gửi prompt trước khi timeout", async () => {
    class TestSubmitWorker extends M365BrowserWorker {
      public async testSubmit(page: any, options: any): Promise<void> {
        await this.submitPrompt(page, options);
      }
    }

    const worker = new TestSubmitWorker();
    let submitted = false;
    let fallbackCalled = false;

    const editorLocator = {
      isVisible: async () => true,
      boundingBox: async () => ({ x: 100, y: 500, width: 400, height: 40 }),
      textContent: async () => (submitted ? "" : "hello world"),
    };
    const sendLocator = {
      isVisible: async () => !submitted,
      isEnabled: async () => !submitted,
      boundingBox: async () => {
        if (submitted) fallbackCalled = true;
        return submitted ? null : { x: 700, y: 760, width: 32, height: 32 };
      },
      click: async () => {
        // Mô phỏng nút Send đã gửi prompt và biến mất ngay trước khi Playwright timeout
        submitted = true;
        throw new Error("TimeoutError: click: Timeout 1000ms exceeded.");
      },
      evaluate: async () => {
        fallbackCalled = true;
      },
    };

    const fakePage: any = {
      waitForTimeout: async () => {},
      mouse: {
        click: async () => {
          fallbackCalled = true;
        },
      },
      locator: (selector: string) => {
        if (selector.includes("Stop generating")) {
          return {
            count: async () => (submitted ? 1 : 0),
            nth: () => ({
              isVisible: async () => submitted,
              boundingBox: async () => ({ x: 700, y: 760, width: 32, height: 32 }),
            }),
          };
        }
        if (selector.includes('aria-label="Send"')) {
          return { count: async () => (submitted ? 0 : 1), nth: () => sendLocator };
        }
        return { count: async () => 1, nth: () => editorLocator };
      },
    };

    await worker.testSubmit(fakePage, { prompt: "hello world" });
    expect(fallbackCalled).toBe(false);
  });

  test("navigate chấp nhận copilot.cloud.microsoft/chat và chịu lỗi ERR_ABORTED khi redirect sang copilot.cloud.microsoft", async () => {
    class TestNavigateWorker extends M365BrowserWorker {
      public async testNavigate(page: any, options: any): Promise<void> {
        await this.navigate(page, options);
      }
    }

    const worker = new TestNavigateWorker();
    const visited: string[] = [];

    // 1. Đã ở copilot.cloud.microsoft/chat -> không gọi page.goto thừa
    await worker.testNavigate(
      {
        url: () => "https://copilot.cloud.microsoft/chat/?auth=2",
        goto: async (url: string) => {
          visited.push(url);
        },
      },
      { prompt: "hi", conversationKey: "k1" },
    );
    expect(visited).toEqual([]);

    // 2. goto bị ERR_ABORTED nhưng đã redirect sang copilot.cloud.microsoft/chat -> thành công
    let currentUrl = "about:blank";
    await worker.testNavigate(
      {
        url: () => currentUrl,
        goto: async (url: string) => {
          visited.push(url);
          currentUrl = "https://copilot.cloud.microsoft/chat";
          throw new Error("page.goto: net::ERR_ABORTED at https://m365.cloud.microsoft/chat");
        },
        waitForLoadState: async () => {},
      },
      { prompt: "hi", conversationKey: "k1" },
    );
    expect(visited).toEqual(["https://m365.cloud.microsoft/chat"]);

    // 3. Kẹt ở trang đăng nhập -> báo lỗi đăng nhập rõ ràng
    await expect(
      worker.testNavigate(
        {
          url: () => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        },
        { prompt: "hi", conversationKey: "k1" },
      ),
    ).rejects.toThrow(/Phiên đăng nhập M365 Copilot/);
  });
});
