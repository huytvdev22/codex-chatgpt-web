/**
 * Helper ghi nhận console log đầu vào chuẩn hóa và an toàn cho toàn bộ module M365 Copilot Adapter.
 * Tự động thu gọn các đối tượng phức tạp như Playwright Page, Buffer, Stream để tránh tràn bộ nhớ console.
 */
export function logFunctionInput(
  moduleName: string,
  fnName: string,
  inputs?: Record<string, unknown> | null,
): void {
  try {
    if (!inputs || Object.keys(inputs).length === 0) {
      console.log(`[m365-copilot:${moduleName}] ${fnName}() called`);
      return;
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(inputs)) {
      if (val === null || val === undefined) {
        sanitized[key] = val;
      } else if (typeof val === "object") {
        // Xử lý đối tượng Playwright Page / BrowserContext
        if ("url" in val && typeof (val as { url?: () => string }).url === "function") {
          try {
            sanitized[key] = `[Playwright Page: ${(val as { url: () => string }).url()}]`;
          } catch {
            sanitized[key] = "[Playwright Page]";
          }
        } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) {
          sanitized[key] = `[Buffer: ${val.length} bytes]`;
        } else if (Array.isArray(val)) {
          sanitized[key] = val.length > 20
            ? `[Array(${val.length}) - hiển thị 5 phần tử đầu: ${JSON.stringify(val.slice(0, 5))}...]`
            : val;
        } else {
          sanitized[key] = val;
        }
      } else if (typeof val === "string" && val.length > 1000) {
        // Rút gọn chuỗi quá dài nhưng vẫn giữ 300 ký tự đầu để soi thông tin
        sanitized[key] = `${val.slice(0, 300)}... [truncated, total ${val.length} chars]`;
      } else {
        sanitized[key] = val;
      }
    }

    console.log(`[m365-copilot:${moduleName}] ${fnName}() input:`, sanitized);
  } catch (err) {
    // Không bao giờ để lỗi logger làm gián đoạn luồng nghiệp vụ
    console.log(`[m365-copilot:${moduleName}] ${fnName}() input: [logging error: ${String(err)}]`);
  }
}
