#!/usr/bin/env node

/**
 * Script hỗ trợ kiểm tra và trích xuất danh sách Model trong menu của Google Gemini Web
 * Chạy bằng Node.js: node scripts/inspect-gemini-models.js
 */

import { chromium } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const USER_DATA_DIR = join(homedir(), ".codex-gemini-web");

async function main() {
  if (!existsSync(USER_DATA_DIR)) {
    mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  console.log("🚀 Đang khởi động Chromium với profile:", USER_DATA_DIR);
  console.log("👉 Nếu bạn chưa đăng nhập Google, hãy đăng nhập trực tiếp trên cửa sổ trình duyệt vừa mở nhé.");

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const page = context.pages()[0] || (await context.newPage());

  console.log("🌐 Đang điều hướng đến https://gemini.google.com/app...");
  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });

  console.log("\n⏳ Đang tìm nút mở danh sách model [data-test-id='bard-mode-menu-button']...");
  try {
    const modelBtn = await page.waitForSelector('button[data-test-id="bard-mode-menu-button"]', {
      timeout: 30_000,
      state: "visible",
    });

    if (modelBtn) {
      console.log("✔ Tìm thấy nút chọn model! Đang click mở menu...");
      await modelBtn.click();
      await page.waitForTimeout(1000);

      // Tìm overlay menu của Angular Material
      const menuItems = await page.$$eval(
        '.cdk-overlay-container [role="menuitem"], .cdk-overlay-container button.mat-mdc-menu-item, .cdk-overlay-container .mat-mdc-menu-item',
        (elements) => elements.map((el) => ({
          text: el.innerText.trim(),
          ariaLabel: el.getAttribute("aria-label"),
          role: el.getAttribute("role"),
          className: el.className,
          html: el.outerHTML.slice(0, 300),
        }))
      );

      console.log(`\n🎉 ĐÃ TÌM THẤY ${menuItems.length} MÔ HÌNH TRONG MENU:`);
      console.log("==================================================");
      menuItems.forEach((item, index) => {
        console.log(`[${index + 1}] Text: "${item.text.replace(/\n+/g, " - ")}"`);
        if (item.ariaLabel) console.log(`    aria-label: "${item.ariaLabel}"`);
        console.log("--------------------------------------------------");
      });

      console.log("\n👉 Bạn có thể đóng cửa sổ trình duyệt khi đã xem xong.");
    }
  } catch (err) {
    console.warn("⚠ Không tìm thấy nút chọn model ngay. Có thể trang đang yêu cầu đăng nhập Google.");
    console.log("Chi tiết lỗi:", err.message);
  }
}

main().catch(console.error);
