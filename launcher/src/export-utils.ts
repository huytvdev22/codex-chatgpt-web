import type { LogRecord } from "./types";

/**
 * Định dạng mảng LogRecord thành Pretty JSON (indent 2)
 */
export function formatLogsAsPrettyJson(records: LogRecord[]): string {
  return JSON.stringify(records, null, 2);
}

/**
 * Định dạng mảng LogRecord thành chuẩn JSON Lines / NDJSON
 */
export function formatLogsAsJsonl(records: LogRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

/**
 * Định dạng tóm tắt log thành dạng văn bản / markdown dễ đọc để paste vào Slack, Jira, Issue
 */
export function formatLogsAsSummary(
  records: LogRecord[],
  title: string,
  durationMs: number
): string {
  const lines: string[] = [];
  lines.push(`=== LOG EXPORT: ${title} ===`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total Records: ${records.length}`);
  if (durationMs > 0) {
    lines.push(`Duration: ${(durationMs / 1000).toFixed(2)}s (${durationMs}ms)`);
  }
  lines.push("------------------------------------------------------------");

  for (const record of records) {
    const detail = record.detail || {};
    const safe = (detail.safeDetails as Record<string, unknown>) || {};
    const timeStr = record.at ? record.at.slice(11, 23) : "??:??:??.???";
    const levelStr = record.level ? record.level.toUpperCase().padEnd(5) : "INFO ";

    const preview =
      (typeof detail.line === "string" && detail.line.trim()) ||
      (typeof detail.message === "string" && detail.message.trim()) ||
      (typeof detail.command === "string" && `$ ${detail.command.trim()}`) ||
      (typeof safe.preview === "string" && safe.preview.trim()) ||
      (typeof safe.modelSlug === "string" && `Model: ${safe.modelSlug}`) ||
      "";

    let line = `[${timeStr}] [${levelStr}] ${record.event}`;
    if (preview) {
      line += ` | ${preview}`;
    }
    lines.push(line);
  }

  lines.push("------------------------------------------------------------");
  return lines.join("\n");
}

/**
 * Tải nội dung văn bản về máy dưới dạng tệp tin (hỗ trợ cả Electron & Browser)
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Sinh tên tệp tin an toàn theo ngữ cảnh
 */
export function generateExportFilename(
  prefix: string,
  id: string,
  extension: "json" | "jsonl" | "txt" | "md"
): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 16);
  return `${prefix}_${cleanId}_${timeStr}.${extension}`;
}
