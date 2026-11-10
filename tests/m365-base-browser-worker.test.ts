import { describe, expect, test } from "bun:test";
import path from "node:path";

const workerPath = path.resolve(
  process.cwd(),
  "src/adapters/m365-copilot/m365-browser-worker.ts",
);

async function readWorkerSource(): Promise<string> {
  return await Bun.file(workerPath).text();
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
      "await this.findVisibleLocator(\n        page,\n        CHAT_SELECTORS.stopButton,",
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

  test("worker kế thừa shared base, extraction và observer đều đã được tách", async () => {
    const source = await readWorkerSource();

    expect(source).toContain(
      "export class M365BrowserWorker extends BaseWebBrowserWorker",
    );
    expect(source).not.toContain(
      "M365 observeResponse compatibility hook must not run before polling migration is complete",
    );
    expect(source).not.toContain(
      "M365 extractCompletedResponse compatibility hook must not run before polling migration is complete",
    );
    expect(source).toContain("protected async observeResponse(");
    expect(source).toContain(
      "responseState.pendingStatus = status as M365ResponseDomStatus;",
    );
    expect(source).toContain(
      "const observation = await this.observeResponse(",
    );
    expect(source).toContain(
      "protected async extractCompletedResponse(",
    );
    expect(source).toContain("protected async waitForCompletion(");
    expect(source).not.toContain("public async executeTurn(");
  });

  test("M365 polling override dùng turn runtime state còn orchestration thuộc shared lifecycle", async () => {
    const source = await readWorkerSource();
    const pollingStart = source.indexOf("protected async waitForCompletion(");
    const pollingSource = source.slice(pollingStart);

    expect(pollingSource).toContain(
      "const responseState = this.getResponseRuntimeState(page);",
    );
    expect(pollingSource).not.toContain(
      "const markdownBuffer = new M365MarkdownBuffer();",
    );
    expect(pollingSource).not.toContain(
      "const fastPathBuffer = new FastPathStreamBuffer();",
    );
    expect(source).not.toContain("public async executeTurn(");
    expect(source).toContain("protected async initializeTurnState(");
    expect(source).toContain("protected async cleanupTurnState(");
    expect(source).toContain("protected async handleExecutionError(");
    expect(source).toContain(
      "this.responseStates.set(page, this.createResponseRuntimeState());",
    );
    expect(source).toContain("this.clearTurnRuntimeState(page);");
  });

  test("response runtime state gom đủ dữ liệu để tách observeResponse và extraction", async () => {
    const source = await readWorkerSource();

    expect(source).toContain("interface M365ResponseRuntimeState {");
    expect(source).toContain(
      "markdownBuffer: InstanceType<typeof M365MarkdownBuffer>;",
    );
    expect(source).toContain("fastPathBuffer: FastPathStreamBuffer;");
    expect(source).toContain("lastFastPathText: string;");
    expect(source).toContain("lastBlocks: M365MarkdownBlock[];");
    expect(source).toContain("lastStatus: M365ResponseDomStatus | null;");
    expect(source).toContain(
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
    const source = await readWorkerSource();

    expect(source).toContain(
      "protected shouldEmitObservationDelta(",
    );
    expect(source).toContain(
      "M365MarkdownBuffer và FastPathStreamBuffer đã phát semantic delta",
    );
    expect(source).toContain("return false;");
    expect(source).toContain(
      "const delta = responseState.fastPathBuffer.observe(",
    );
    expect(source).toContain(
      "const delta = responseState.markdownBuffer.observe(",
    );
  });
});
