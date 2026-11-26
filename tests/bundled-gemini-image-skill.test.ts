import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SkillDirectoryScanner } from "../src/skills/skill-directory-scanner";
import { SkillPromptBuilder } from "../src/skills/skill-prompt-builder";
import { syncBundledCodexSkills } from "../src/skills/bundled-skill-sync";
import { createDefaultSkillsSettings } from "../src/skills/types";

const ONE_BY_ONE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function runNodeAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

describe("Bundled $gemini-image skill & CLI helper", () => {
  test("syncBundledCodexSkills cài đặt gemini-image sang CODEX_HOME/skills, tránh ghi đè skill thủ công và hỗ trợ mention $gemini-image", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "bundled-skill-sync-"));
    try {
      const targetSkillsDir = join(tmpRoot, "skills");
      const first = syncBundledCodexSkills({ targetSkillsDir });
      expect(first.synced).toEqual(["gemini-image"]);
      expect(existsSync(join(targetSkillsDir, "gemini-image", "SKILL.md"))).toBe(true);
      expect(existsSync(join(targetSkillsDir, "gemini-image", "LICENSE.txt"))).toBe(true);
      expect(existsSync(join(targetSkillsDir, "gemini-image", "agents", "openai.yaml"))).toBe(true);
      expect(existsSync(join(targetSkillsDir, "gemini-image", "assets", "imagegen.png"))).toBe(true);
      expect(existsSync(join(targetSkillsDir, "gemini-image", "references", "prompting.md"))).toBe(true);
      expect(existsSync(join(targetSkillsDir, "gemini-image", "references", "sample-prompts.md"))).toBe(true);
      expect(existsSync(join(targetSkillsDir, "gemini-image", "scripts", "gemini-image.mjs"))).toBe(true);

      const second = syncBundledCodexSkills({ targetSkillsDir });
      expect(second.unchanged).toEqual(["gemini-image"]);
      expect(second.synced).toEqual([]);

      // Không ghi đè nếu là skill do người dùng tự tạo (không có manifest quản lý)
      const unmanagedDir = join(tmpRoot, "unmanaged-skills");
      mkdirSync(join(unmanagedDir, "gemini-image"), { recursive: true });
      writeFileSync(join(unmanagedDir, "gemini-image", "SKILL.md"), "---\nname: gemini-image\ndescription: custom\n---\ncustom");
      const third = syncBundledCodexSkills({ targetSkillsDir: unmanagedDir });
      expect(third.skipped).toEqual(["gemini-image"]);
      expect(readFileSync(join(unmanagedDir, "gemini-image", "SKILL.md"), "utf8")).toContain("custom");

      // Kiểm chứng SkillDirectoryScanner & SkillPromptBuilder tự nạp $gemini-image
      const scanner = new SkillDirectoryScanner();
      const scanned = scanner.scanDirectories([{ path: targetSkillsDir, enabled: true }], "user");
      expect(scanned.skills.some((s) => s.name === "gemini-image")).toBe(true);

      const builder = new SkillPromptBuilder();
      const settings = createDefaultSkillsSettings();
      const selected = builder.resolveExplicitSkillMentions(
        "Dùng $gemini-image vẽ cho tôi bức ảnh mèo 16:9",
        scanned.skills,
        [],
        settings,
      );
      expect(selected).toHaveLength(1);
      expect(selected[0]?.name).toBe("gemini-image");
      expect(selected[0]?.body).toContain("scripts/gemini-image.mjs");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("gemini-image.mjs gọi /v1/images/generations và /v1/images/edits bằng Node.js và lưu PNG chuẩn", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "gemini-image-mjs-"));
    const calls: Array<{ path: string; body: Record<string, unknown>; threadMeta: string | null }> = [];
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = (await req.json()) as Record<string, unknown>;
        calls.push({
          path: url.pathname,
          body,
          threadMeta: req.headers.get("x-codex-turn-metadata"),
        });
        return Response.json({
          created: Math.floor(Date.now() / 1000),
          data: [{ b64_json: ONE_BY_ONE_PNG_B64, revised_prompt: String(body.prompt ?? "") }],
          output_format: "png",
        });
      },
    });

    try {
      const scriptPath = resolve(process.cwd(), "assets", "skills", "gemini-image", "scripts", "gemini-image.mjs");
      const genOut = join(tmpRoot, "out-gen.png");
      const genRes = await runNodeAsync([
        scriptPath,
        "generate",
        "--base-url",
        `http://127.0.0.1:${srv.port}`,
        "--prompt",
        "A cat by a window",
        "--ratio",
        "16:9",
        "--thread-id",
        "thread-apikey-1",
        "--out",
        genOut,
      ]);
      expect(genRes.status).toBe(0);
      const genJson = JSON.parse(genRes.stdout) as { ok: boolean; path: string; width: number; height: number };
      expect(genJson.ok).toBe(true);
      expect(genJson.path).toBe(genOut);
      expect(genJson.width).toBe(1);
      expect(genJson.height).toBe(1);
      expect(existsSync(genOut)).toBe(true);

      const editOut = join(tmpRoot, "out-edit.png");
      const editRes = await runNodeAsync([
        scriptPath,
        "edit",
        "--base-url",
        `http://127.0.0.1:${srv.port}`,
        "--image",
        genOut,
        "--prompt",
        "Change sky to night",
        "--thread-id",
        "thread-apikey-1",
        "--out",
        editOut,
      ]);
      expect(editRes.status).toBe(0);
      expect(existsSync(editOut)).toBe(true);

      expect(calls).toHaveLength(2);
      expect(calls[0]?.path).toBe("/v1/images/generations");
      expect(String(calls[0]?.body.prompt)).toContain("Preferred aspect ratio: 16:9.");
      expect(calls[0]?.threadMeta).toContain("thread-apikey-1");
      expect(calls[1]?.path).toBe("/v1/images/edits");
      expect(Array.isArray(calls[1]?.body.images)).toBe(true);
    } finally {
      srv.stop(true);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
