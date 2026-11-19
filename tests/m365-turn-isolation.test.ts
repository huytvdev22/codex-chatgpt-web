import { afterEach, describe, expect, test } from "bun:test";
import {
  detectM365MessageQuotaError,
  M365DomObserver,
} from "../src/adapters/m365-copilot/m365-dom-observer";
import { M365ClipboardSalvage } from "../src/adapters/m365-copilot/m365-clipboard-salvage";

type AttrMap = Record<string, string>;

class FakeElement {
  public readonly nodeType = 1;
  public readonly tagName: string;
  public readonly children: FakeElement[] = [];
  public parentElement: FakeElement | null = null;
  public className = "";
  public id = "";
  public innerText = "";
  private readonly attrs: AttrMap = {};
  private _text = "";

  constructor(
    tagName: string,
    options: {
      id?: string;
      className?: string;
      attrs?: AttrMap;
      text?: string;
      children?: FakeElement[];
    } = {},
  ) {
    this.tagName = tagName.toUpperCase();
    if (options.id) {
      this.id = options.id;
      this.attrs.id = options.id;
    }
    if (options.className) {
      this.className = options.className;
      this.attrs.class = options.className;
    }
    if (options.attrs) {
      Object.assign(this.attrs, options.attrs);
    }
    if (typeof options.text === "string") {
      this._text = options.text;
      this.innerText = options.text;
    }
    if (options.children) {
      for (const child of options.children) {
        this.appendChild(child);
      }
    }
  }

  get childNodes(): FakeElement[] {
    return this.children;
  }

  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  get textContent(): string {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join("");
  }

  set textContent(value: string) {
    this._text = value;
    this.innerText = value;
    this.children.length = 0;
  }

  get innerHTML(): string {
    const childMarkup = this.children.map((c) => c.outerHTML).join("");
    return `${this._text}${childMarkup}`;
  }

  get outerHTML(): string {
    const attrsStr = Object.entries(this.attrs)
      .map(([k, v]) => ` ${k}="${v}"`)
      .join("");
    const tag = this.tagName.toLowerCase();
    return `<${tag}${attrsStr}>${this.innerHTML}</${tag}>`;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceWith(replacement: FakeElement): void {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) {
      replacement.parentElement = this.parentElement;
      this.parentElement.children[idx] = replacement;
    }
  }

  remove(): void {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) {
      this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
  }

  cloneNode(deep = false): FakeElement {
    const cloned = new FakeElement(this.tagName, {
      id: this.id,
      className: this.className,
      attrs: { ...this.attrs },
      text: this._text,
    });
    if (deep) {
      for (const child of this.children) {
        cloned.appendChild(child.cloneNode(true));
      }
    }
    return cloned;
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
    if (name === "id") this.id = value;
    if (name === "class") this.className = value;
  }

  contains(other: unknown): boolean {
    let curr = other as FakeElement | null;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentElement ?? null;
    }
    return false;
  }

  closest(selector: string): FakeElement | null {
    let curr: FakeElement | null = this;
    while (curr) {
      if (curr.matches(selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  matches(selector: string): boolean {
    return selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .some((part) => this.matchesSingleSelector(part));
  }

  querySelectorAll<T = FakeElement>(selector: string): T[] {
    const results: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results as unknown as T[];
  }

  querySelector<T = FakeElement>(selector: string): T | null {
    return (this.querySelectorAll<T>(selector)[0] ?? null) as T | null;
  }

  private matchesSingleSelector(sel: string): boolean {
    if (sel.includes(":not(")) {
      const notMatch = sel.match(/^(.*):not\(([^)]+)\)$/);
      if (notMatch) {
        const [, base, excluded] = notMatch;
        const baseMatches = !base || this.matchesSingleSelector(base);
        return baseMatches && !this.matchesSingleSelector(excluded);
      }
    }
    if (sel.startsWith(".")) {
      return this.className.split(/\s+/).includes(sel.slice(1));
    }
    if (sel.startsWith("#")) {
      return this.id === sel.slice(1);
    }
    if (sel.startsWith("[")) {
      const attrEq = sel.match(/^\[([^=\]]+)=['"]([^'"]+)['"]\]$/);
      if (attrEq) {
        return this.getAttribute(attrEq[1]) === attrEq[2];
      }
      const attrContains = sel.match(/^\[([^*=\]]+)\*=['"]([^'"]+)['"](?:\s*i)?\]$/);
      if (attrContains) {
        const val = this.getAttribute(attrContains[1]) || "";
        return val.toLowerCase().includes(attrContains[2].toLowerCase());
      }
      const attrExists = sel.match(/^\[([^\]]+)\]$/);
      if (attrExists) {
        return this.hasAttribute(attrExists[1]);
      }
    }
    const tagAttr = sel.match(/^([a-z0-9]+)(\[.*\]|#[a-z0-9_-]+)$/i);
    if (tagAttr) {
      return (
        this.tagName.toLowerCase() === tagAttr[1].toLowerCase() &&
        this.matchesSingleSelector(tagAttr[2])
      );
    }
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }
}

function createDomHarness() {
  const body = new FakeElement("body");
  const win: Record<string, any> = {};
  const doc = {
    body,
    querySelectorAll: <T = FakeElement>(sel: string) => body.querySelectorAll<T>(sel),
    querySelector: <T = FakeElement>(sel: string) => body.querySelector<T>(sel),
    createElement: (tag: string) => new FakeElement(tag),
  };

  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevNode = (globalThis as any).Node;
  (globalThis as any).window = win;
  (globalThis as any).document = doc;
  (globalThis as any).Node = { ELEMENT_NODE: 1 };

  const page: any = {
    evaluate: async (fn: (arg: any) => any, arg?: any) => fn(arg),
    waitForTimeout: async () => {},
    context: () => ({ grantPermissions: async () => {} }),
    locator: () => ({
      count: async () => 0,
      last: () => ({
        locator: () => ({
          last: () => ({ count: async () => 0 }),
        }),
      }),
    }),
  };

  const restore = () => {
    (globalThis as any).window = prevWindow;
    (globalThis as any).document = prevDocument;
    (globalThis as any).Node = prevNode;
  };

  return { body, win, doc, page, restore };
}

function createCodeBlockMessage(lines: Array<{ index: number; text: string }>, withCopyButton = true) {
  const lineNodes = lines.map(
    (l) =>
      new FakeElement("div", {
        attrs: { "data-line-index": String(l.index) },
        text: l.text,
      }),
  );
  const codeBlockChildren: FakeElement[] = [
    new FakeElement("div", {
      attrs: { "data-testid": "one-copilot-code-identity" },
      children: [new FakeElement("span", { text: "Markdown" })],
    }),
    ...lineNodes,
  ];
  if (withCopyButton) {
    codeBlockChildren.push(
      new FakeElement("button", {
        id: "copy-button",
        attrs: { "aria-label": "Copy code" },
      }),
    );
  }
  const codeBlock = new FakeElement("div", {
    className: "scriptor-component-code-block",
    children: codeBlockChildren,
  });
  const reply = new FakeElement("div", {
    attrs: { "data-testid": "markdown-reply", "data-message-type": "Chat" },
    children: [codeBlock],
  });
  const msg = new FakeElement("div", {
    className: "fai-CopilotMessage",
    attrs: { "data-content": "ai-message" },
    children: [reply],
  });
  return { msg, codeBlock, lineNodes };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("M365 multi-turn DOM & cache isolation", () => {
  test("không đọc lại tin nhắn baseline cũ khi virtual scroll làm thay đổi DOM tin nhắn Turn 1 và không trộn dòng sang Turn 2", async () => {
    const harness = createDomHarness();
    cleanups.push(harness.restore);

    const observer = new M365DomObserver();
    const turn1Lines = [
      { index: 0, text: "<webResponse>" },
      { index: 1, text: '<custom_tool_call name="apply_patch">' },
      { index: 2, text: "*** Begin Patch" },
      { index: 3, text: "*** Add File: docs/codebase-review-backlog.md" },
      { index: 11, text: "+- Rủi ro chính: Tài liệu kiến trúc không đồng bộ." },
      { index: 12, text: "+- Nợ kỹ thuật: Một số file quá lớn." },
      { index: 13, text: "*** End Patch" },
      { index: 14, text: "</custom_tool_call>" },
      { index: 15, text: "</webResponse>" },
    ];
    const t1Baseline = await observer.captureBaseline(harness.page);
    expect(t1Baseline.aiCount).toBe(0);

    const freshTurn1 = createCodeBlockMessage(turn1Lines);
    harness.body.appendChild(freshTurn1.msg);

    const t1Status = await observer.captureStatus(harness.page, t1Baseline);
    expect(t1Status.fastPathRawText).toContain("+- Rủi ro chính");

    // Bắt đầu Turn 2: captureBaseline đánh dấu Turn 1 là baseline cũ
    const t2Baseline = await observer.captureBaseline(harness.page);
    expect(t2Baseline.aiCount).toBe(1);
    expect(freshTurn1.msg.hasAttribute("data-codex-turn-baseline")).toBe(true);

    // Giả lập Turn 2 đang generating (Stop button hiện), Turn 2 message chưa mount,
    // nhưng virtualized DOM của Turn 1 thay đổi innerHTML/textContent do trang cuộn xuống.
    const stopBtn = new FakeElement("button", {
      attrs: { "aria-label": "Stop generating" },
    });
    harness.body.appendChild(stopBtn);
    freshTurn1.lineNodes[4].textContent =
      "+- Rủi ro chính: Tài liệu kiến trúc không đồng bộ (re-rendered).";

    const midStatus = await observer.captureStatus(
      harness.page,
      t2Baseline,
      { lightweightWhileGenerating: true },
    );
    expect(midStatus.isNew).toBe(false);
    expect(midStatus.hasContent).toBe(false);

    // Turn 2 mount tin nhắn mới gồm 5 dòng (index 0..4), ngắn hơn Turn 1 (index 0..15)
    stopBtn.remove();
    const turn2 = createCodeBlockMessage([
      { index: 0, text: "<webResponse>" },
      { index: 1, text: "## Đã hoàn tất" },
      { index: 2, text: "Mình đã lưu file xong." },
      { index: 3, text: "</webResponse>" },
    ]);
    harness.body.appendChild(turn2.msg);

    const t2Status = await observer.captureStatus(harness.page, t2Baseline, {
      lightweightWhileGenerating: false,
    });
    expect(t2Status.isNew).toBe(true);
    expect(t2Status.fastPathRawText).toBe(
      "<webResponse>\n## Đã hoàn tất\nMình đã lưu file xong.\n</webResponse>",
    );
    expect(t2Status.fastPathRawText).not.toContain("Rủi ro chính");
  });

  test("chỉ đọc Monaco Editor gắn bên trong block/tin nhắn mới, không lấy nhầm Monaco model của Turn 1", async () => {
    const harness = createDomHarness();
    cleanups.push(harness.restore);

    const turn1 = createCodeBlockMessage([
      { index: 0, text: "<webResponse>" },
      { index: 1, text: "*** Begin Patch" },
    ]);
    const turn1MonacoDom = new FakeElement("div", { className: "monaco-editor" });
    turn1.codeBlock.appendChild(turn1MonacoDom);

    harness.body.appendChild(turn1.msg);
    const observer = new M365DomObserver();
    const baseline = await observer.captureBaseline(harness.page);

    const turn2 = createCodeBlockMessage([
      { index: 0, text: "<webResponse>" },
      { index: 1, text: "## Đã hoàn tất" },
      { index: 2, text: "</webResponse>" },
    ]);
    harness.body.appendChild(turn2.msg);

    const turn1FullText =
      "<webResponse>\n*** Begin Patch\n+- Rủi ro chính: old turn\n*** End Patch\n</webResponse>";
    harness.win.monaco = {
      editor: {
        getModels: () => [{ getValue: () => turn1FullText }],
        getEditors: () => [
          {
            getDomNode: () => turn1MonacoDom,
            getModel: () => ({ getValue: () => turn1FullText }),
          },
        ],
      },
    };

    const status = await observer.captureStatus(harness.page, baseline);
    expect(status.fastPathRawText).toBe(
      "<webResponse>\n## Đã hoàn tất\n</webResponse>",
    );

    // M365ClipboardSalvage cũng không được bốc Monaco model của Turn 1
    const salvage = new M365ClipboardSalvage();
    const salvaged = await salvage.tryExtractCodeViaCopyButton(harness.page);
    expect(salvaged).toBeNull();
  });

  test("M365ClipboardSalvage trả về null khi Turn 2 chỉ là text thuần không có code block dù Turn 1 có nút Copy và Monaco model", async () => {
    const harness = createDomHarness();
    cleanups.push(harness.restore);

    const turn1 = createCodeBlockMessage([
      { index: 0, text: "<webResponse>" },
      { index: 1, text: "old patch" },
      { index: 2, text: "</webResponse>" },
    ]);
    const turn1MonacoDom = new FakeElement("div", { className: "monaco-editor" });
    turn1.codeBlock.appendChild(turn1MonacoDom);
    harness.body.appendChild(turn1.msg);

    const observer = new M365DomObserver();
    await observer.captureBaseline(harness.page);

    // Turn 2 chỉ là plain paragraph, không có code block hay copy button
    const turn2Msg = new FakeElement("div", {
      className: "fai-CopilotMessage",
      attrs: { "data-content": "ai-message" },
      children: [
        new FakeElement("div", {
          attrs: { "data-testid": "markdown-reply", "data-message-type": "Chat" },
          children: [new FakeElement("p", { text: "Đã xong rồi bạn nhé." })],
        }),
      ],
    });
    harness.body.appendChild(turn2Msg);

    harness.win.monaco = {
      editor: {
        getModels: () => [
          { getValue: () => "<webResponse>\n<custom_tool_call name=\"apply_patch\">old</custom_tool_call>\n</webResponse>" },
        ],
        getEditors: () => [
          {
            getDomNode: () => turn1MonacoDom,
            getModel: () => ({
              getValue: () =>
                "<webResponse>\n<custom_tool_call name=\"apply_patch\">old</custom_tool_call>\n</webResponse>",
            }),
          },
        ],
      },
    };

    const salvage = new M365ClipboardSalvage();
    const salvaged = await salvage.tryExtractCodeViaCopyButton(harness.page);
    expect(salvaged).toBeNull();
  });

  test("M365DomObserver phát hiện thông báo hết hạn mức ngày trong .fai-CopilotMessage__content và ném lỗi dừng ngay (không dính Share feedback)", async () => {
    const harness = createDomHarness();
    cleanups.push(harness.restore);

    const observer = new M365DomObserver();
    const baseline = await observer.captureBaseline(harness.page);
    const runtimeState = observer.createRuntimeState();

    // Đúng cấu trúc DOM thực tế khi M365 hết hạn mức ngày
    const quotaContent = new FakeElement("div", {
      id: "copilot-message-_r_226_",
      className: "fai-CopilotMessage__content r1izxv8h",
      children: [
        new FakeElement("div", {
          children: [
            new FakeElement("div", {
              children: [
                new FakeElement("span", {
                  text: "You've used your daily chat limit. Please try again tomorrow.",
                }),
                new FakeElement("span", {
                  children: [
                    new FakeElement("section", {
                      children: [
                        new FakeElement("div", {
                          attrs: { role: "group", "aria-label": "Provide your feedback on BizChat" },
                          children: [
                            new FakeElement("button", { text: "Share feedback" }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const copilotMsg = new FakeElement("div", {
      className: "fai-CopilotMessage",
      attrs: { "data-content": "ai-message" },
      children: [quotaContent],
    });
    harness.body.appendChild(copilotMsg);

    const status = await observer.captureStatus(harness.page, baseline);
    expect(status.detectedWebError).toBe(
      "You've used your daily chat limit. Please try again tomorrow.",
    );
    expect(status.hasContent).toBe(false);
    expect(status.blocks).toEqual([]);

    await expect(
      observer.applyStatus(harness.page, runtimeState, status, {}),
    ).rejects.toThrow("[M365 Web Error] You've used your daily chat limit. Please try again tomorrow.");
  });

  test("detectM365MessageQuotaError không bắt nhầm nội dung kỹ thuật dài hoặc bọc trong <webResponse>", () => {
    expect(
      detectM365MessageQuotaError(
        "<webResponse>\nYou've used your daily chat limit. Please try again tomorrow.\n</webResponse>",
      ),
    ).toBe("");
    expect(
      detectM365MessageQuotaError(
        "Here is how we handle errors when Copilot prints 'You've used your daily chat limit': " +
          "x".repeat(360),
      ),
    ).toBe("");
    expect(
      detectM365MessageQuotaError("You've used your daily chat limit. Please try again tomorrow."),
    ).toBe("You've used your daily chat limit. Please try again tomorrow.");
  });
});
