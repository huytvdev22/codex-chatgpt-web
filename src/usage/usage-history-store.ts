import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import type { UsageTurnRecord } from "./types";

const MAX_USAGE_HISTORY_BYTES = 2 * 1024 * 1024;
const KEEP_RECENT_RECORDS = 4_000;

/**
 * Kho lưu nhật ký sử dụng Token theo từng turn dạng JSONL tại `<configDir>/usage-history.jsonl`.
 * Tự động cắt gọn an toàn khi file vượt ngưỡng để giữ dung lượng nhỏ.
 */
export class UsageHistoryStore {
  constructor(private readonly customFilePath?: string) {}

  public resolveFilePath(): string {
    return this.customFilePath ?? join(getConfigDir(), "usage-history.jsonl");
  }

  public append(record: UsageTurnRecord): void {
    try {
      if (this.shouldSkipImplicitTestWrite()) {
        return;
      }
      const filePath = this.resolveFilePath();
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      appendFileSync(filePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.trimIfOversized(filePath);
    } catch {
      // Non-fatal: logging token usage must never break a live response turn
    }
  }

  public readAll(): UsageTurnRecord[] {
    const filePath = this.resolveFilePath();
    if (!existsSync(filePath)) return [];
    try {
      const raw = readFileSync(filePath, "utf8");
      const records: UsageTurnRecord[] = [];
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as UsageTurnRecord;
          if (parsed && typeof parsed.timestamp === "string" && typeof parsed.totalTokens === "number") {
            records.push(parsed);
          }
        } catch {
          // Ignore malformed line
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  private shouldSkipImplicitTestWrite(): boolean {
    if (this.customFilePath) return false;
    if (process.env.CODEX_CHATGPT_WEB_HOME?.trim()) return false;
    return (
      process.env.NODE_ENV === "test" ||
      process.argv.some(
        (arg) => arg === "test" || /\.test\.[cm]?[jt]sx?$/i.test(arg),
      )
    );
  }

  private trimIfOversized(filePath: string): void {
    try {
      const stats = statSync(filePath);
      if (stats.size <= MAX_USAGE_HISTORY_BYTES) return;
      const lines = readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
      if (lines.length <= KEEP_RECENT_RECORDS) return;
      const kept = lines.slice(-KEEP_RECENT_RECORDS).join("\n") + "\n";
      atomicWriteFile(filePath, kept);
    } catch {
      // Non-fatal
    }
  }
}

export const usageHistoryStore = new UsageHistoryStore();
