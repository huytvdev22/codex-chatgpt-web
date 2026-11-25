import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterExtractedStorageState,
  isAllowedChromeSessionHost,
  removeTemporaryChromeTabSessions,
  resolveChromeCookieRootDomains,
} from "../src/chrome-session-extractor";

describe("chrome-session-extractor", () => {
  test("chỉ cho phép các domain Google/AI Studio hợp lệ", () => {
    expect(isAllowedChromeSessionHost(".google.com")).toBe(true);
    expect(isAllowedChromeSessionHost("accounts.google.com")).toBe(true);
    expect(isAllowedChromeSessionHost("aistudio.google.com")).toBe(true);
    expect(isAllowedChromeSessionHost("evil-google.com")).toBe(false);
    expect(isAllowedChromeSessionHost("google.com.evil.org")).toBe(false);
    expect(isAllowedChromeSessionHost("")).toBe(false);
  });

  test("lọc cookie hợp lệ, bỏ partitionKey và chỉ giữ localStorage đúng origin mục tiêu", () => {
    const filtered = filterExtractedStorageState(
      {
        cookies: [
          {
            name: "SID",
            value: "sid-value",
            domain: ".google.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "None",
          },
          {
            name: "PART_COOKIE",
            value: "skip",
            domain: ".google.com",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "None",
            partitionKey: "https://google.com",
          } as never,
          {
            name: "TRACKER",
            value: "skip",
            domain: ".doubleclick.net",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [
          {
            origin: "https://aistudio.google.com",
            localStorage: [{ name: "aistudio.pref", value: "1" }],
          },
          {
            origin: "https://accounts.google.com",
            localStorage: [{ name: "other", value: "x" }],
          },
        ],
      },
      "https://aistudio.google.com",
    );

    expect(filtered.origin).toBe("https://aistudio.google.com");
    expect(filtered.cookies).toHaveLength(1);
    expect(filtered.cookies[0]?.name).toBe("SID");
    expect(filtered.localStorage).toEqual([{ name: "aistudio.pref", value: "1" }]);
  });

  test("xóa sạch tab session artifacts tạm mà vẫn giữ Cookies", () => {
    const dir = mkdtempSync(join(tmpdir(), "chrome-extractor-clean-"));
    try {
      const def = join(dir, "Default");
      mkdirSync(join(def, "Sessions"), { recursive: true });
      writeFileSync(join(def, "Sessions", "Session_1"), "tab");
      writeFileSync(join(def, "Current Session"), "old");
      writeFileSync(join(def, "Last Tabs"), "old");
      writeFileSync(join(def, "Cookies"), "keep-me");

      removeTemporaryChromeTabSessions(dir);

      expect(existsSync(join(def, "Sessions"))).toBe(false);
      expect(existsSync(join(def, "Current Session"))).toBe(false);
      expect(existsSync(join(def, "Last Tabs"))).toBe(false);
      expect(existsSync(join(def, "Cookies"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hỗ trợ allowlist domain cho ChatGPT và chặn provider lạ", () => {
    const chatgptDomains = resolveChromeCookieRootDomains("chatgpt");
    expect(isAllowedChromeSessionHost("chatgpt.com", chatgptDomains)).toBe(true);
    expect(isAllowedChromeSessionHost(".openai.com", chatgptDomains)).toBe(true);
    expect(isAllowedChromeSessionHost("auth.openai.com", chatgptDomains)).toBe(true);
    expect(isAllowedChromeSessionHost(".google.com", chatgptDomains)).toBe(false);
    expect(() => resolveChromeCookieRootDomains("unknown-provider")).toThrow(
      "Unsupported external Chrome login provider: unknown-provider",
    );

    const filtered = filterExtractedStorageState(
      {
        cookies: [
          {
            name: "__Secure-next-auth.session-token.0",
            value: "part0",
            domain: "chatgpt.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
          {
            name: "__Secure-next-auth.session-token.1",
            value: "part1",
            domain: ".chatgpt.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
          {
            name: "SID",
            value: "google-sid-should-skip",
            domain: ".google.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "None",
          },
        ],
        origins: [
          {
            origin: "https://chatgpt.com",
            localStorage: [{ name: "oai/apps/lastModel", value: "gpt-6.2" }],
          },
          {
            origin: "https://aistudio.google.com",
            localStorage: [{ name: "ignore", value: "1" }],
          },
        ],
      },
      "https://chatgpt.com",
      chatgptDomains,
    );

    expect(filtered.origin).toBe("https://chatgpt.com");
    expect(filtered.cookies.map((c) => c.name)).toEqual([
      "__Secure-next-auth.session-token.0",
      "__Secure-next-auth.session-token.1",
    ]);
    expect(filtered.localStorage).toEqual([{ name: "oai/apps/lastModel", value: "gpt-6.2" }]);
  });

  test("hỗ trợ allowlist domain cho Gemini", () => {
    const geminiDomains = resolveChromeCookieRootDomains("gemini");
    expect(isAllowedChromeSessionHost("gemini.google.com", geminiDomains)).toBe(true);
    expect(isAllowedChromeSessionHost(".google.com", geminiDomains)).toBe(true);
    expect(isAllowedChromeSessionHost("chatgpt.com", geminiDomains)).toBe(false);
  });
});
