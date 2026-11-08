import { describe, expect, test } from "bun:test";
import path from "node:path";

const workerPath = path.resolve(
  process.cwd(),
  "src/adapters/m365-copilot/browser/browser-worker.ts",
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
    expect(source).toContain(
      "const fullMarkdown = await this.extractCompletedResponse(",
    );
    expect(source).toContain("public async executeTurn(");
  });

  test("compatibility polling dùng turn runtime state và lifecycle cleanup hook", async () => {
    const source = await readWorkerSource();
    const executeTurnStart = source.indexOf("public async executeTurn(");
    const executeTurnSource = source.slice(executeTurnStart);

    expect(executeTurnSource).toContain(
      "const responseState = this.getResponseRuntimeState(page);",
    );
    expect(executeTurnSource).not.toContain(
      "const markdownBuffer = new M365MarkdownBuffer();",
    );
    expect(executeTurnSource).not.toContain(
      "const fastPathBuffer = new FastPathStreamBuffer();",
    );
    expect(executeTurnSource).toContain("} finally {");
    expect(executeTurnSource).toContain(
      "await this.cleanupTurnState(page, options);",
    );
    expect(source).toContain("protected async initializeTurnState(");
    expect(source).toContain("protected async cleanupTurnState(");
    expect(source).toContain(
      "this.responseStates.set(page, this.createResponseRuntimeState());",
    );
    expect(source).toContain("this.clearTurnRuntimeState(page);");
  });

  test("response runtime state gom đủ dữ liệu để tách observeResponse và extraction", async () => {
    const source = await readWorkerSource();

    expect(source).toContain("interface M365ResponseRuntimeState {");
    expect(source).toContain("markdownBuffer: M365MarkdownBuffer;");
    expect(source).toContain("fastPathBuffer: FastPathStreamBuffer;");
    expect(source).toContain("lastFastPathText: string;");
    expect(source).toContain("lastBlocks: M365MarkdownBlock[];");
    expect(source).toContain("lastStatus: M365ResponseDomStatus | null;");
    expect(source).toContain(
      "private readonly responseStates = new WeakMap<",
    );
  });
});
