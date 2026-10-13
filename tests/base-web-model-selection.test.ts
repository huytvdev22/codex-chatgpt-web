import { describe, expect, test } from "bun:test";
import {
  ModelSelectionRequestDto,
  IllegalArgumentException,
  ModelSelectionResultDto,
  SelectionStatusCode,
  ModelSpecDto,
  ModelMenuStateDto,
  BaseModelSelector,
  type IDomDriver,
  type IModelVerifier,
  type IMenuNavigationStrategy,
  type NavigationStepResult,
} from "../src/adapters/base-web/model-selection";
import {
  M365CapabilityPicker,
  M365_CAPABILITY_SPECS,
  defaultM365CapabilityPicker as defaultCapabilityPicker,
} from "../src/adapters/m365-copilot/browser/m365-capability-specs";
const ensureM365CapabilityMode = (page: any, mode: any) => defaultCapabilityPicker.ensureMode(page, mode);

/**
 * Trình giả lập Mock IDomDriver cho Unit Test thuần túy (không cần bật Chromium)
 */
class MockDomDriver implements IDomDriver {
  public evaluatedActions: Array<{ fnName?: string; arg?: any }> = [];
  public pressedKeys: string[] = [];
  public clickedSelectors: string[] = [];
  public sleepCalls: number[] = [];

  constructor(
    public evalHandler: (arg?: any) => any = () => true
  ) {}

  async evaluate<T, R>(fn: (param: T) => R | Promise<R>, arg: T): Promise<R>;
  async evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  async evaluate<T, R>(fn: any, arg?: T): Promise<R> {
    this.evaluatedActions.push({ fnName: fn.name, arg });
    return this.evalHandler(arg);
  }

  async waitForSelector(selector: string, timeoutMs: number): Promise<boolean> {
    return true;
  }

  async click(selector: string, timeoutMs?: number): Promise<boolean> {
    this.clickedSelectors.push(selector);
    return true;
  }

  async pressKey(key: string): Promise<void> {
    this.pressedKeys.push(key);
  }

  async sleep(ms: number): Promise<void> {
    this.sleepCalls.push(ms);
  }
}

describe("Base Web Model Selection - Enterprise DTO Layer", () => {
  test("ModelSelectionRequestDto: Khởi tạo hợp lệ và kiểm tra Immutability", () => {
    const req = ModelSelectionRequestDto.of("think", {
      timeoutMs: 3000,
      settleDelayMs: 200,
      forceReselect: true,
      traceId: "trace-123",
    });

    expect(req.targetMode).toBe("think");
    expect(req.timeoutMs).toBe(3000);
    expect(req.settleDelayMs).toBe(200);
    expect(req.forceReselect).toBe(true);
    expect(req.traceId).toBe("trace-123");
    expect(Object.isFrozen(req)).toBe(true);

    const json = req.toJSON();
    expect(json.targetMode).toBe("think");
    expect(json.traceId).toBe("trace-123");
  });

  test("ModelSelectionRequestDto: Từ chối targetMode rỗng bằng IllegalArgumentException", () => {
    expect(() => ModelSelectionRequestDto.of("")).toThrow(IllegalArgumentException);
    expect(() => ModelSelectionRequestDto.of("   ")).toThrow(IllegalArgumentException);
    expect(() => ModelSelectionRequestDto.of(null as any)).toThrow(IllegalArgumentException);
  });

  test("ModelSelectionResultDto: Static Factory Methods & Immutability", () => {
    // 1. Success
    const successRes = ModelSelectionResultDto.createSuccess("quick", 150, "Auto");
    expect(successRes.isOk()).toBe(true);
    expect(successRes.statusCode).toBe(SelectionStatusCode.SUCCESS);
    expect(successRes.durationMs).toBe(150);
    expect(successRes.previousActiveLabel).toBe("Auto");
    expect(Object.isFrozen(successRes)).toBe(true);

    // 2. Already Active
    const alreadyRes = ModelSelectionResultDto.createAlreadyActive("think", 20, "Think deeper");
    expect(alreadyRes.isOk()).toBe(true);
    expect(alreadyRes.statusCode).toBe(SelectionStatusCode.ALREADY_ACTIVE);
    expect(alreadyRes.durationMs).toBe(20);

    // 3. Failure
    const failRes = ModelSelectionResultDto.createFailure(
      "gpt-5.6-think",
      SelectionStatusCode.ITEM_NOT_FOUND,
      500,
      "Menu item not found"
    );
    expect(failRes.isOk()).toBe(false);
    expect(failRes.statusCode).toBe(SelectionStatusCode.ITEM_NOT_FOUND);
    expect(failRes.message).toContain("Menu item not found");
  });

  test("ModelSpecDto: Khởi tạo và so khớp nhãn text (matchesText)", () => {
    const spec = new ModelSpecDto({
      mode: "claude-3-7-thinking",
      label: "Claude 3.7 Sonnet (Thinking)",
      aliasLabels: ["Thinking", "Sonnet 3.7"],
    });

    expect(spec.mode).toBe("claude-3-7-thinking");
    expect(spec.matchesText("Claude 3.7 Sonnet (Thinking)")).toBe(true);
    expect(spec.matchesText("Giao diện Thinking")).toBe(true);
    expect(spec.matchesText("Sonnet 3.7")).toBe(true);
    expect(spec.matchesText("GPT-4o")).toBe(false);
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.aliasLabels)).toBe(true);
  });

  test("ModelMenuStateDto: Khởi tạo và bất biến", () => {
    const state = new ModelMenuStateDto({
      isMenuVisible: true,
      activeOptionLabel: "Think deeper",
      availableOptionLabels: ["Auto", "Quick", "Think deeper"],
    });

    expect(state.isMenuVisible).toBe(true);
    expect(state.activeOptionLabel).toBe("Think deeper");
    expect(state.availableOptionLabels.length).toBe(3);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.availableOptionLabels)).toBe(true);
  });
});

describe("BaseModelSelector - Template Method Orchestration", () => {
  type TestMode = "fast" | "pro";

  class TestModelVerifier implements IModelVerifier<TestMode> {
    public callCount = 0;
    public preVerifyActive = false;
    public postVerifyActive = true;

    async isModelActive(driver: IDomDriver, spec: ModelSpecDto<TestMode>): Promise<boolean> {
      this.callCount++;
      return this.callCount === 1 ? this.preVerifyActive : this.postVerifyActive;
    }
  }

  class TestNavigationStrategy implements IMenuNavigationStrategy<TestMode> {
    readonly strategyName = "TestNavigationStrategy";
    public openMenuSuccess = true;
    public selectStepResult: NavigationStepResult = { success: true, clicked: true, alreadyChecked: false };
    public closeMenuCalled = false;

    supports(spec: ModelSpecDto<TestMode>): boolean {
      return true;
    }

    async openMenu(driver: IDomDriver): Promise<boolean> {
      return this.openMenuSuccess;
    }

    async selectItem(driver: IDomDriver, spec: ModelSpecDto<TestMode>): Promise<NavigationStepResult> {
      return this.selectStepResult;
    }

    async closeMenu(driver: IDomDriver): Promise<void> {
      this.closeMenuCalled = true;
      await driver.pressKey("Escape");
    }
  }

  class TestModelSelector extends BaseModelSelector<TestMode> {
    readonly selectorName = "test-selector";
    public verifier = new TestModelVerifier();
    public strategy = new TestNavigationStrategy();

    protected get modelVerifier(): IModelVerifier<TestMode> {
      return this.verifier;
    }

    protected get navigationStrategies(): readonly IMenuNavigationStrategy<TestMode>[] {
      return [this.strategy];
    }

    protected readonly specsMap = new Map<TestMode, ModelSpecDto<TestMode>>([
      ["fast", new ModelSpecDto({ mode: "fast", label: "Fast Model" })],
      ["pro", new ModelSpecDto({ mode: "pro", label: "Pro Model" })],
    ]);

    resolveMode(modelSlug?: string, reasoning?: string): TestMode {
      return modelSlug === "pro" ? "pro" : "fast";
    }
  }

  test("Template Method Step 1: Fast-path return ALREADY_ACTIVE khi UI đã ở đúng mode", async () => {
    const selector = new TestModelSelector();
    selector.verifier.preVerifyActive = true;
    const mockDriver = new MockDomDriver();

    const req = ModelSelectionRequestDto.of("pro");
    const result = await selector.ensureModel(mockDriver, req);

    expect(result.isOk()).toBe(true);
    expect(result.statusCode).toBe(SelectionStatusCode.ALREADY_ACTIVE);
    expect(selector.strategy.closeMenuCalled).toBe(false);
  });

  test("Template Method Step 2 & 3: Báo lỗi MENU_OPEN_FAILED nếu mở menu thất bại", async () => {
    const selector = new TestModelSelector();
    selector.verifier.preVerifyActive = false;
    selector.strategy.openMenuSuccess = false;
    const mockDriver = new MockDomDriver();

    const req = ModelSelectionRequestDto.of("pro");
    const result = await selector.ensureModel(mockDriver, req);

    expect(result.isOk()).toBe(false);
    expect(result.statusCode).toBe(SelectionStatusCode.MENU_OPEN_FAILED);
  });

  test("Template Method Step 4: Xử lý option đã được check sẵn trong menu (alreadyChecked)", async () => {
    const selector = new TestModelSelector();
    selector.verifier.preVerifyActive = false;
    selector.strategy.openMenuSuccess = true;
    selector.strategy.selectStepResult = { success: true, clicked: false, alreadyChecked: true };
    const mockDriver = new MockDomDriver();

    const req = ModelSelectionRequestDto.of("fast");
    const result = await selector.ensureModel(mockDriver, req);

    expect(result.isOk()).toBe(true);
    expect(result.statusCode).toBe(SelectionStatusCode.ALREADY_ACTIVE);
    expect(selector.strategy.closeMenuCalled).toBe(true);
    expect(mockDriver.pressedKeys).toContain("Escape");
  });

  test("Template Method Step 4: Báo lỗi ITEM_NOT_FOUND nếu không click được item", async () => {
    const selector = new TestModelSelector();
    selector.verifier.preVerifyActive = false;
    selector.strategy.openMenuSuccess = true;
    selector.strategy.selectStepResult = { success: false, clicked: false, alreadyChecked: false, reason: "Element missing" };
    const mockDriver = new MockDomDriver();

    const req = ModelSelectionRequestDto.of("fast");
    const result = await selector.ensureModel(mockDriver, req);

    expect(result.isOk()).toBe(false);
    expect(result.statusCode).toBe(SelectionStatusCode.ITEM_NOT_FOUND);
    expect(selector.strategy.closeMenuCalled).toBe(true);
  });

  test("Template Method: Chuyển đổi thành công toàn bộ 6 bước", async () => {
    const selector = new TestModelSelector();
    selector.verifier.preVerifyActive = false;
    selector.strategy.openMenuSuccess = true;
    selector.strategy.selectStepResult = { success: true, clicked: true, alreadyChecked: false };
    const mockDriver = new MockDomDriver();

    const req = ModelSelectionRequestDto.of("pro", { settleDelayMs: 50 });
    const result = await selector.ensureModel(mockDriver, req);

    expect(result.isOk()).toBe(true);
    expect(result.statusCode).toBe(SelectionStatusCode.SUCCESS);
    expect(mockDriver.sleepCalls).toContain(50);
  });
});

describe("M365CapabilityPicker - Concrete Provider Implementation", () => {
  test("M365CapabilityPicker kế thừa BaseModelSelector và nạp đủ 5 capability modes", () => {
    const picker = new M365CapabilityPicker();
    expect(picker.selectorName).toBe("m365-capability");

    const specs = picker.getSupportedSpecs();
    expect(specs.size).toBe(5);
    expect(specs.has("auto")).toBe(true);
    expect(specs.has("quick")).toBe(true);
    expect(specs.has("think")).toBe(true);
    expect(specs.has("gpt-5.6-think")).toBe(true);
    expect(specs.has("gpt-5.6-quick")).toBe(true);

    const gptThinkSpec = specs.get("gpt-5.6-think")!;
    expect(gptThinkSpec.isSubmenu).toBe(true);
    expect(gptThinkSpec.parentMenuIdentifier).toBe("gptSubMenuModelTrigger-OpenAI");
  });

  test("resolveMode: Phân giải chính xác model slug sang M365 Capability Mode", () => {
    const picker = new M365CapabilityPicker();
    expect(picker.resolveMode("m365-copilot/quick")).toBe("quick");
    expect(picker.resolveMode("m365-copilot/think")).toBe("think");
    expect(picker.resolveMode("m365-copilot/gpt-5.6", "high")).toBe("gpt-5.6-think");
    expect(picker.resolveMode("m365-copilot/gpt-5.6", "low")).toBe("gpt-5.6-quick");
  });

  test("M365 Backward Compatibility: ensureM365CapabilityMode và defaultCapabilityPicker tồn tại", () => {
    expect(defaultCapabilityPicker).toBeDefined();
    expect(defaultCapabilityPicker instanceof M365CapabilityPicker).toBe(true);
    expect(typeof ensureM365CapabilityMode).toBe("function");
    expect(M365_CAPABILITY_SPECS.auto.label).toBe("Auto");
  });
});
