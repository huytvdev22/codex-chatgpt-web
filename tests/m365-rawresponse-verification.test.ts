import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { parseStrictM365Response } from "../src/adapters/base-web/translation";
import { buildM365FormatRetryPrompt } from "../src/adapters/base-web/prompts";

describe("M365 Raw Response Reproduction & Analysis", () => {
  let rawContent = "";
  const rawFilePath = path.resolve(".m365_conversation/m365-rawressponse.txt");
  if (fs.existsSync(rawFilePath)) {
    rawContent = fs.readFileSync(rawFilePath, "utf-8").trim();
  }

  // Nếu file text bị xóa hoặc rỗng, trích xuất từ snapshot m365-resposne-element.html
  if (!rawContent) {
    const htmlPath = path.resolve(".m365_conversation/m365-resposne-element.html");
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, "utf-8");
      const regex = /<div\s+data-line-index="(\d+)"[^>]*>([\s\S]*?)<\/div>/g;
      let m;
      const map = new Map<number, string>();
      while ((m = regex.exec(html)) !== null) {
        const idx = parseInt(m[1], 10);
        let text = m[2]
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, "\"")
          .replace(/\u00a0/g, " ")
          .replace(/\r?\n\s*/g, " ");
        map.set(idx, text);
      }
      const keys = Array.from(map.keys()).sort((a, b) => a - b);
      const lines: string[] = [];
      for (let i = keys[0]; i <= keys[keys.length - 1]; i++) {
        lines.push(map.get(i) ?? "");
      }
      rawContent = lines.join("\n").replace(/^\n+|\n+$/g, "");
    }
  }

  test("khi phản hồi đầy đủ 465 dòng: parseStrictM365Response thành công và trích xuất đúng tool call apply_patch", () => {
    if (!rawContent) return;
    const result = parseStrictM365Response(rawContent);

    // Không được báo lỗi protocol
    expect(result.kind).toBe("tool_calls");

    if (result.kind === "tool_calls") {
      expect(result.calls).toHaveLength(1);
      const call = result.calls[0];
      expect(call.name).toBe("apply_patch");
      expect(typeof call.arguments.input).toBe("string");

      const patch = call.arguments.input as string;
      expect(patch).toStartWith("*** Begin Patch");
      expect(patch).toEndWith("*** End Patch");
      expect(patch).toContain("*** Add File: corp-sale-lead-service/src/main/java/vn/com/gpbank/corp/sale/lead/service/impl/TaskImportServiceImpl.java");
      expect(patch).toContain("+package vn.com.gpbank.corp.sale.lead.service.impl;");
      expect(patch).toContain("+public class TaskImportServiceImpl implements TaskImportService {");
    }
  });

  test("khi phản hồi bị cắt tại dòng 74 (do DOM Virtualization của M365 UI): tái hiện CHÍNH XÁC lỗi MISSING_RESPONSE_ENVELOPE", () => {
    if (!rawContent) return;
    const lines = rawContent.split("\n");
    const truncatedContent = lines.slice(0, 74).join("\n");

    const result = parseStrictM365Response(truncatedContent);

    expect(result.kind).toBe("protocol_error");

    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");

      expect(result.message).toContain("Phản hồi không có root response envelope hợp lệ nhưng chứa reserved control marker.");
      expect(result.message).toContain("Các cú pháp điều khiển được phát hiện trong phản hồi: <custom_tool_call name=\"apply_patch\">, *** Begin Patch, <m365Response>.");
      expect(result.message).toContain("Chẩn đoán lỗi: Bạn đã mở thẻ <m365Response> nhưng THIẾU thẻ đóng </m365Response> ở cuối phản hồi.");

      const retryPrompt = buildM365FormatRetryPrompt({
        code: result.code,
        message: result.message,
      });

      expect(retryPrompt).toContain("[M365 RESPONSE FORMAT ERROR - BẮT BUỘC PHÁT LẠI PHẢN HỒI TRƯỚC]");
      expect(retryPrompt).toContain("Mã lỗi: MISSING_RESPONSE_ENVELOPE");
    }
  });

  test("khi phản hồi thiếu thẻ đóng </m365Response> nhưng có đủ patch: vẫn kích hoạt MISSING_RESPONSE_ENVELOPE", () => {
    if (!rawContent) return;
    const lines = rawContent.split("\n");
    const missingClosingRoot = lines.slice(0, lines.length - 1).join("\n");

    const result = parseStrictM365Response(missingClosingRoot);
    expect(result.kind).toBe("protocol_error");
    if (result.kind === "protocol_error") {
      expect(result.code).toBe("MISSING_RESPONSE_ENVELOPE");
      expect(result.message).toContain("<custom_tool_call name=\"apply_patch\">");
      expect(result.message).toContain("</custom_tool_call>");
      expect(result.message).toContain("*** Begin Patch");
      expect(result.message).toContain("*** End Patch");
      expect(result.message).toContain("<m365Response>");
    }
  });
});
