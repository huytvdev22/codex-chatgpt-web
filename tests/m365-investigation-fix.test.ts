import { describe, expect, it } from "bun:test";
import { CodexPayloadNormalizer } from "../src/adapters/m365-copilot/codex-normalizer";
import { CodexRawPayload } from "../src/adapters/m365-copilot/codex-raw-payload";
import { M365ToolBridge } from "../src/adapters/m365-copilot/tool-bridge";
import { M365OutputTranslator, normalizeToolName } from "../src/adapters/m365-copilot/output-translator";
import { FastPathStreamBuffer, findSuffixPrefixOverlap } from "../src/adapters/m365-copilot/temp-chat/fastPathScraper";
import type { CodexTool } from "../src/types";

describe("M365 Investigation & Fix Verification Tests", () => {
  describe("1. Loại bỏ namespace 'functions' mặc định (Bảo toàn Native Tool Names)", () => {
    it("chuẩn hóa native tools bọc trong namespace 'functions' thành short name exec_command, write_stdin, apply_patch", () => {
      const rawPayload = CodexRawPayload.from({
        model: "m365-copilot/think",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              { type: "function", name: "exec_command", description: "Runs command" },
              { type: "function", name: "write_stdin", description: "Writes stdin" },
              { type: "custom", name: "apply_patch", description: "Applies patch" },
            ],
          },
          {
            type: "namespace",
            name: "web",
            tools: [
              { type: "function", name: "run", description: "Web search" },
            ],
          },
        ],
        input: [],
      });

      const normalized = CodexPayloadNormalizer.normalize(rawPayload);

      // Các native tools KHÔNG ĐƯỢC có prefix functions.
      const execTool = normalized.activeCodingTools.find(t => t.identity.name === "exec_command");
      expect(execTool).toBeDefined();
      expect(execTool?.identity.namespace).toBeUndefined();
      expect(execTool?.identity.qualifiedName).toBe("exec_command");

      const patchTool = normalized.activeCodingTools.find(t => t.identity.name === "apply_patch");
      expect(patchTool).toBeDefined();
      expect(patchTool?.identity.namespace).toBeUndefined();
      expect(patchTool?.identity.qualifiedName).toBe("apply_patch");

      // Tool MCP như web.run vẫn giữ namespace web
      const webTool = normalized.activeCodingTools.find(t => t.identity.qualifiedName === "web.run");
      expect(webTool).toBeDefined();
      expect(webTool?.identity.namespace).toBe("web");
      expect(webTool?.identity.name).toBe("run");
    });

    it("resolveToolByName hỗ trợ tra cứu cả khi truyền functions.exec_command", () => {
      const tools = CodexPayloadNormalizer.extractTools(CodexRawPayload.from({
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "function", name: "exec_command" }],
          },
        ],
      }));

      const res = CodexPayloadNormalizer.resolveToolByName(tools, "functions.exec_command");
      expect(res.tool).toBeDefined();
      expect(res.tool?.identity.name).toBe("exec_command");
    });
  });

  describe("2. Tự động loại bỏ tiền tố functions. trong Tool Bridge và Output Translator", () => {
    it("M365ToolBridge tự động chuyển functions.exec_command thành exec_command", () => {
      const clientTools: CodexTool[] = [
        { name: "exec_command", description: "", parameters: {} },
      ];

      const mapped = M365ToolBridge.mapToolCall(
        {
          name: "functions.exec_command",
          arguments: { cmd: "npm install && npm test" },
        },
        clientTools
      );

      expect(mapped.name).toBe("exec_command");
      const args = JSON.parse(mapped.arguments);
      expect(args.cmd).toBe("npm install && npm test");
    });

    it("M365OutputTranslator dịch <tool_call> chứa functions.exec_command thành exec_command", () => {
      const translator = new M365OutputTranslator();
      const raw = `<tool_call>
{"name": "functions.exec_command", "arguments": {"cmd": "npm test"}}
</tool_call>`;

      const res = translator.translate(raw);
      expect(res.type).toBe("tool_call");
      if (res.type === "tool_call") {
        expect(res.tool_calls[0].function.name).toBe("exec_command");
      }
    });

    it("normalizeToolName loại bỏ chính xác tiền tố functions.", () => {
      expect(normalizeToolName("functions.exec_command")).toBe("exec_command");
      expect(normalizeToolName("functions.apply_patch")).toBe("apply_patch");
      expect(normalizeToolName("web.run")).toBe("web.run");
      expect(normalizeToolName("exec_command")).toBe("exec_command");
    });
  });

  describe("3. FastPathStreamBuffer chống mất dữ liệu khi DOM Virtualization xảy ra", () => {
    it("findSuffixPrefixOverlap tìm chính xác điểm giao thoa giữa 2 chuỗi", () => {
      const existing = "line 1\nline 2\nline 3\nline 4\nline 5";
      const incoming = "line 4\nline 5\nline 6\nline 7";
      const overlapLen = findSuffixPrefixOverlap(existing, incoming, 5);
      expect(overlapLen).toBe("line 4\nline 5".length);
      const newPart = incoming.slice(overlapLen);
      expect(newPart).toBe("\nline 6\nline 7");
    });

    it("bảo toàn 100% phần đầu khi DOM Virtualization làm mất các dòng trên", () => {
      const buffer = new FastPathStreamBuffer();

      // Chunk 1: Copilot bắt đầu sinh khối patch (chứa header đầy đủ)
      const chunk1 = `<custom_tool_call name="apply_patch">
*** Begin Patch
*** Add File: openapi.yaml
+openapi: 3.0.3
+info:
+  title: Todos API
+paths:
+  /api/todos:
+    get:
+      summary: List todos`;

      const delta1 = buffer.observe(chunk1);
      expect(delta1).toBe(chunk1);

      // Chunk 2: Monaco Virtual Scrolling cuộn xuống, unmount các dòng đầu!
      // DOM chỉ còn từ +paths trở đi đến hết
      const chunk2 = `+paths:
+  /api/todos:
+    get:
+      summary: List todos
+PayloadTooLarge:
+  description: Request body vượt giới hạn
*** End Patch
</custom_tool_call>`;

      const delta2 = buffer.observe(chunk2);
      // Delta2 chỉ phát phần đuôi mới thêm vào (từ PayloadTooLarge trở đi)
      expect(delta2).toContain("PayloadTooLarge");

      const finalRes = buffer.finish();
      // Chuỗi cuối cùng PHẢI CHỨA CẢ PHẦN ĐẦU CỦA CHUNK 1 VÀ PHẦN ĐUÔI CỦA CHUNK 2!
      expect(finalRes.markdown).toContain('<custom_tool_call name="apply_patch">');
      expect(finalRes.markdown).toContain("*** Begin Patch");
      expect(finalRes.markdown).toContain("*** Add File: openapi.yaml");
      expect(finalRes.markdown).toContain("+openapi: 3.0.3");
      expect(finalRes.markdown).toContain("PayloadTooLarge");
      expect(finalRes.markdown).toContain("*** End Patch");
      expect(finalRes.markdown).toContain("</custom_tool_call>");

      // Kiểm chứng M365OutputTranslator nhận diện đúng apply_patch mà KHÔNG bị fallback sang final_answer
      const translator = new M365OutputTranslator();
      const translated = translator.translate(finalRes.markdown);
      expect(translated.type).toBe("tool_call");
      if (translated.type === "tool_call") {
        expect(translated.tool_calls[0].function.name).toBe("apply_patch");
      }
    });
  });
});
