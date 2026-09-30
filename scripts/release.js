#!/usr/bin/env node

/**
 * SOLID Release & Version Manager
 * Script tự động hóa kiểm tra đồng bộ, nâng phiên bản và phát hành Git Tag lên GitHub.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "..");

// ==========================================
// 1. Command Runner & Logger (DIP)
// ==========================================
class CommandRunner {
  static run(command, cwd = ROOT_DIR) {
    return execSync(command, { cwd, encoding: "utf8", stdio: "pipe" });
  }

  static runInherit(command, cwd = ROOT_DIR) {
    execSync(command, { cwd, stdio: "inherit" });
  }
}

class Logger {
  static info(msg) {
    console.log(`\x1b[36mℹ ${msg}\x1b[0m`);
  }
  static success(msg) {
    console.log(`\x1b[32m✔ ${msg}\x1b[0m`);
  }
  static warn(msg) {
    console.log(`\x1b[33m⚠ ${msg}\x1b[0m`);
  }
  static error(msg) {
    console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
  }
}

// ==========================================
// 2. Version Strategy & Updates (SRP & OCP)
// ==========================================
class VersionReplacer {
  /**
   * Định nghĩa các rule thay thế phiên bản trên các tệp (OCP - dễ mở rộng thêm tệp mới)
   */
  static getTargets(oldVer, newVer) {
    return [
      {
        path: "package.json",
        transform: (content) =>
          content.replace(/"version":\s*"[^"]+"/, `"version": "${newVer}"`),
      },
      {
        path: "launcher/package.json",
        transform: (content) =>
          content.replace(/"version":\s*"[^"]+"/, `"version": "${newVer}"`),
      },
      {
        path: "src/version.ts",
        transform: (content) =>
          content.replace(
            /export const VERSION = "[^"]+";/,
            `export const VERSION = "${newVer}";`
          ),
      },
      {
        path: "scripts/install.sh",
        transform: (content) =>
          content.replace(
            /VERSION="\${CODEX_CHATGPT_WEB_VERSION:-[^}]+}"/,
            `VERSION="\${CODEX_CHATGPT_WEB_VERSION:-${newVer}}"`
          ),
      },
      // Các file tài liệu README
      ...["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"].map(
        (readmeFile) => ({
          path: readmeFile,
          transform: (content) =>
            content.replaceAll(
              `/releases/download/v${oldVer}/codex-web-gpt-${oldVer}-`,
              `/releases/download/v${newVer}/codex-web-gpt-${newVer}-`
            ),
        })
      ),
    ];
  }

  static applyVersionBump(oldVer, newVer, dryRun = false) {
    const targets = this.getTargets(oldVer, newVer);
    for (const target of targets) {
      const fullPath = resolve(ROOT_DIR, target.path);
      if (!existsSync(fullPath)) {
        Logger.warn(`Không tìm thấy file: ${target.path}, bỏ qua.`);
        continue;
      }
      const original = readFileSync(fullPath, "utf8");
      const updated = target.transform(original);
      if (original === updated) {
        Logger.warn(`Không có thay đổi nào trong ${target.path}`);
      } else {
        if (!dryRun) {
          writeFileSync(fullPath, updated, "utf8");
        }
        Logger.success(`Đã cập nhật ${target.path} -> v${newVer}`);
      }
    }
  }
}

// ==========================================
// 3. Git Operations Service (SRP)
// ==========================================
class GitService {
  static getCurrentBranch() {
    return CommandRunner.run("git rev-parse --abbrev-ref HEAD").trim();
  }

  static isWorkingTreeClean() {
    const status = CommandRunner.run("git status -s").trim();
    return status.length === 0;
  }

  static tagExists(tagName) {
    const tags = CommandRunner.run(`git tag -l ${tagName}`).trim();
    return tags.length > 0;
  }

  static createTag(tagName, message) {
    CommandRunner.run(`git tag -a ${tagName} -m "${message}"`);
  }

  static pushTag(tagName, remote = "origin") {
    CommandRunner.runInherit(`git push ${remote} ${tagName}`);
  }

  static commitVersionBump(newVer) {
    CommandRunner.run("git add .");
    CommandRunner.run(`git commit -m "chore: nâng phiên bản lên v${newVer}"`);
  }

  static pushCurrentBranch(remote = "origin") {
    const branch = this.getCurrentBranch();
    CommandRunner.runInherit(`git push ${remote} ${branch}`);
  }
}

// ==========================================
// 4. Release Orchestrator (SOLID Coordinator)
// ==========================================
class ReleaseApp {
  constructor() {
    this.packageJsonPath = resolve(ROOT_DIR, "package.json");
    this.packageJson = JSON.parse(readFileSync(this.packageJsonPath, "utf8"));
    this.currentVersion = this.packageJson.version;
  }

  verifyEnvironment() {
    Logger.info("Đang kiểm tra tính đồng bộ phiên bản hiện tại...");
    try {
      CommandRunner.runInherit("bun run check-version");
    } catch {
      throw new Error(
        "Kiểm tra phiên bản thất bại. Hãy kiểm tra lại file bằng `bun run check-version`."
      );
    }
  }

  handleTagAndRelease(targetVersion, shouldPush = true) {
    const tagName = `v${targetVersion}`;
    Logger.info(`Bắt đầu quy trình phát hành tag: ${tagName}`);

    if (GitService.tagExists(tagName)) {
      throw new Error(`Git Tag ${tagName} đã tồn tại ở local!`);
    }

    // 1. Tạo Git Tag
    GitService.createTag(tagName, `Phát hành phiên bản ${tagName}`);
    Logger.success(`Đã tạo tag ${tagName} ở local.`);

    // 2. Push tag lên remote GitHub
    if (shouldPush) {
      Logger.info(`Đang đẩy tag ${tagName} lên GitHub origin...`);
      GitService.pushTag(tagName);
      Logger.success(
        `Đã đẩy tag ${tagName} lên GitHub thành công! Workflow Release sẽ tự động kích hoạt.`
      );
    } else {
      Logger.warn(`Cờ --no-push được bật. Bạn có thể tự push bằng lệnh: git push origin ${tagName}`);
    }
  }

  bump(newVersion, shouldPush = true) {
    if (!newVersion) {
      throw new Error("Vui lòng cung cấp số phiên bản mới (ví dụ: node scripts/release.js bump 6.1.4)");
    }
    if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(newVersion)) {
      throw new Error(`Định dạng phiên bản '${newVersion}' không hợp lệ. Chuẩn semver ví dụ: 6.1.4`);
    }

    if (newVersion === this.currentVersion) {
      throw new Error(`Phiên bản mới trùng với phiên bản hiện tại (${this.currentVersion})!`);
    }

    if (!GitService.isWorkingTreeClean()) {
      throw new Error(
        "Working tree chưa sạch (còn file chưa commit). Vui lòng commit hoặc stash trước khi nâng phiên bản!"
      );
    }

    Logger.info(`Nâng phiên bản: ${this.currentVersion} -> ${newVersion}`);
    VersionReplacer.applyVersionBump(this.currentVersion, newVersion);

    // Xác thực lại tính đồng bộ sau khi sửa đổi
    this.verifyEnvironment();

    // Commit các tệp đã sửa
    Logger.info("Đang commit các tệp cập nhật phiên bản...");
    GitService.commitVersionBump(newVersion);
    Logger.success(`Đã commit: chore: nâng phiên bản lên v${newVersion}`);

    if (shouldPush) {
      Logger.info("Đang đẩy commit lên nhánh hiện tại...");
      GitService.pushCurrentBranch();
    }

    // Tạo tag và đẩy release
    this.handleTagAndRelease(newVersion, shouldPush);
  }

  run() {
    const args = process.argv.slice(2);
    const shouldPush = !args.includes("--no-push");
    const cleanArgs = args.filter((arg) => arg !== "--no-push");

    const command = cleanArgs[0];

    try {
      if (!command || command === "current" || command === "tag") {
        // Mặc định: Release phiên bản hiện tại trong package.json
        Logger.info(`Phiên bản hiện tại trong package.json: ${this.currentVersion}`);
        this.verifyEnvironment();
        this.handleTagAndRelease(this.currentVersion, shouldPush);
      } else if (command === "bump") {
        const nextVersion = cleanArgs[1];
        this.bump(nextVersion, shouldPush);
      } else if (/^\d+\.\d+\.\d+/.test(command)) {
        // Cú pháp ngắn: node scripts/release.js 6.1.4
        this.bump(command, shouldPush);
      } else {
        console.log(`
Cách sử dụng:
  1. Phát hành phiên bản hiện tại (${this.currentVersion}):
     node scripts/release.js

  2. Nâng lên phiên bản mới và phát hành tự động:
     node scripts/release.js 6.1.4
     (hoặc: node scripts/release.js bump 6.1.4)

  3. Tạo tag ở local mà không đẩy lên GitHub:
     node scripts/release.js --no-push
`);
      }
    } catch (err) {
      Logger.error(err.message);
      process.exit(1);
    }
  }
}

// Khởi chạy ứng dụng
new ReleaseApp().run();
