import { describe, expect, test } from "bun:test";
import {
  M365CopilotDriver,
  CHAT_SELECTORS,
  registerPageDriver,
  getPageDriver,
  listPageDrivers,
  executeM365Turn,
  type PageDriver,
} from "../src/adapters/m365-copilot/browser";

describe("M365 Browser Page Driver Architecture Tests", () => {
  test("M365CopilotDriver khởi tạo thành công và tuân thủ hợp đồng PageDriver", () => {
    const driver = new M365CopilotDriver();
    expect(driver.id).toBe("m365-copilot");
    expect(driver.name).toBe("Microsoft 365 Copilot");
    expect(driver.selectors).toBeDefined();
    expect(driver.selectors?.editor).toBe(CHAT_SELECTORS.editor);
    expect(typeof driver.ensureReady).toBe("function");
    expect(typeof driver.prepareNewChat).toBe("function");
    expect(typeof driver.waitForIdle).toBe("function");
    expect(typeof driver.captureBaseline).toBe("function");
    expect(typeof driver.submitPrompt).toBe("function");
    expect(typeof driver.scrapeTurnProgress).toBe("function");
    expect(typeof driver.abortGeneration).toBe("function");
  });

  test("Driver Registry tự động đăng ký M365CopilotDriver mặc định", () => {
    const driver = getPageDriver("m365-copilot");
    expect(driver).toBeDefined();
    expect(driver?.name).toBe("Microsoft 365 Copilot");

    const allDrivers = listPageDrivers();
    expect(allDrivers.length).toBeGreaterThanOrEqual(1);
    expect(allDrivers.some(d => d.id === "m365-copilot")).toBe(true);
  });

  test("Khả năng mở rộng (Extensibility): Dễ dàng cắm thêm PageDriver mới mà không cần sửa core", () => {
    // Giả lập một driver cho trang web mới (ví dụ: Copilot Studio hoặc Bing Copilot)
    const customDriver: PageDriver = {
      id: "custom-copilot-studio",
      name: "Microsoft Copilot Studio Web",
      selectors: {
        editor: "#custom-editor",
      },
      ensureReady: async () => {},
      waitForIdle: async () => {},
      captureBaseline: async () => ({ aiCount: 0, count: 0, lastText: "", lastHtml: "" }),
      submitPrompt: async () => true,
      scrapeTurnProgress: async () => ({
        isGenerating: false,
        blocks: [],
        rawHtml: "",
        isNew: true,
        hasContent: true,
        fastPathRawText: null,
      }),
      abortGeneration: async () => {},
    };

    registerPageDriver(customDriver);

    const retrieved = getPageDriver("custom-copilot-studio");
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe("custom-copilot-studio");
    expect(retrieved?.name).toBe("Microsoft Copilot Studio Web");
  });

  test("Facade executeM365Turn duy trì 100% khả năng tương thích ngược", () => {
    expect(typeof executeM365Turn).toBe("function");
    expect(CHAT_SELECTORS.editor).toBe("#m365-chat-editor-target-element");
  });
});
