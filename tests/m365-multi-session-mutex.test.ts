import { describe, expect, it } from "bun:test";
import { TurnMutex } from "../src/adapters/m365-copilot/browser/engine/turn-mutex";
import { resolvePageDriver, registerPageDriver } from "../src/adapters/m365-copilot/browser/engine/driver-registry";
import { M365CopilotDriver } from "../src/adapters/m365-copilot/browser/drivers/m365-copilot-driver";
import type { PageDriver } from "../src/adapters/m365-copilot/browser/contracts/page-driver";

describe("M365 Multi-VSCode Session & Turn Mutex Tests", () => {
  describe("TurnMutex: Tuần tự hóa lượt tương tác", () => {
    it("đảm bảo hai tác vụ gọi đồng thời được xếp hàng thực thi tuần tự (FIFO)", async () => {
      const mutex = new TurnMutex();
      const executionOrder: string[] = [];

      const task1 = mutex.runExclusive(async () => {
        executionOrder.push("task1:start");
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push("task1:end");
        return "result1";
      });

      const task2 = mutex.runExclusive(async () => {
        executionOrder.push("task2:start");
        await new Promise(r => setTimeout(r, 10));
        executionOrder.push("task2:end");
        return "result2";
      });

      const [r1, r2] = await Promise.all([task1, task2]);

      expect(r1).toBe("result1");
      expect(r2).toBe("result2");
      expect(executionOrder).toEqual([
        "task1:start",
        "task1:end",
        "task2:start",
        "task2:end",
      ]);
    });

    it("giải phóng mutex an toàn ngay cả khi một tác vụ ném lỗi ngoại lệ", async () => {
      const mutex = new TurnMutex();

      await expect(
        mutex.runExclusive(async () => {
          throw new Error("Lỗi giả lập trong task 1");
        })
      ).rejects.toThrow("Lỗi giả lập trong task 1");

      // Task 2 vẫn phải được chạy bình thường sau khi task 1 fail
      const result = await mutex.runExclusive(async () => {
        return "task2:success";
      });

      expect(result).toBe("task2:success");
    });
  });

  describe("Dynamic Page Driver Resolution", () => {
    it("nhận diện M365CopilotDriver khi không có providerId hoặc providerId là m365-copilot", () => {
      const driver1 = resolvePageDriver();
      expect(driver1.id).toBe("m365-copilot");

      const driver2 = resolvePageDriver("m365-copilot");
      expect(driver2.id).toBe("m365-copilot");
    });

    it("cho phép đăng ký và tự động phân giải Driver mới mà không sửa code dùng chung", () => {
      const customDriver = {
        id: "mock-custom-provider",
        name: "Mock Provider Web",
        canHandle: (opts: { providerId?: string }) => opts.providerId === "mock-custom-provider",
        ensureReady: async () => {},
        waitForIdle: async () => {},
        captureBaseline: async () => ({ aiCount: 0, count: 0, lastText: "", lastHtml: "" }),
        submitPrompt: async () => true,
        scrapeTurnProgress: async () => ({ isGenerating: false, blocks: [], rawHtml: "", isNew: false, hasContent: true, fastPathRawText: null }),
        abortGeneration: async () => {},
      } as unknown as PageDriver;

      registerPageDriver(customDriver);

      const resolved = resolvePageDriver("mock-custom-provider");
      expect(resolved.id).toBe("mock-custom-provider");
      expect(resolved.name).toBe("Mock Provider Web");
    });
  });

  describe("Multi-Session Context Isolation", () => {
    it("ghi nhớ Thread URL riêng biệt cho từng conversationKey của từng cửa sổ VS Code", () => {
      const driver = new M365CopilotDriver();

      // Cửa sổ 1 (Project A)
      driver.recordConversationThread("vscode-window-project-a", "https://copilot.microsoft.com/chats/thread-alpha-123");

      // Cửa sổ 2 (Project B)
      driver.recordConversationThread("vscode-window-project-b", "https://copilot.microsoft.com/chats/thread-beta-456");

      // Kiểm tra URL được bảo toàn độc lập
      expect(driver.getSavedThreadUrl("vscode-window-project-a")).toBe("https://copilot.microsoft.com/chats/thread-alpha-123");
      expect(driver.getSavedThreadUrl("vscode-window-project-b")).toBe("https://copilot.microsoft.com/chats/thread-beta-456");
      expect(driver.getSavedThreadUrl("vscode-window-project-c")).toBeUndefined();
    });
  });
});
