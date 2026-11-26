#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

const SUPPORTED_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);

function expandHome(rawPath) {
  if (!rawPath) return homedir();
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return join(homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function getCodexHomeDir() {
  const envHome = process.env.CODEX_HOME?.trim();
  return resolve(expandHome(envHome || join(homedir(), ".codex")));
}

function getBridgeHomeDir() {
  const envHome = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  return resolve(expandHome(envHome || join(homedir(), ".codex-m365-copilot")));
}

function resolveBridgeBaseUrl(explicitBaseUrl) {
  const candidate = explicitBaseUrl?.trim() || process.env.CODEX_CHATGPT_WEB_BASE_URL?.trim();
  if (candidate) {
    return candidate.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
  }

  const codexConfigPath = join(getCodexHomeDir(), "config.toml");
  if (existsSync(codexConfigPath)) {
    try {
      const text = readFileSync(codexConfigPath, "utf8");
      const match = /^\s*openai_base_url\s*=\s*"([^"]+)"/m.exec(text);
      if (match?.[1]) {
        return match[1].trim().replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
      }
    } catch {
      // ignore parse errors and try bridge config
    }
  }

  const bridgeConfigPath = join(getBridgeHomeDir(), "config.json");
  if (existsSync(bridgeConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(bridgeConfigPath, "utf8"));
      if (cfg && typeof cfg.port === "number" && cfg.port > 0) {
        const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : "127.0.0.1";
        return `http://${host}:${cfg.port}`;
      }
    } catch {
      // ignore parse errors and use default
    }
  }

  return "http://127.0.0.1:17841";
}

function parseCliArgs(argv) {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    return { help: true };
  }

  const command = argv[0];
  if (command !== "generate" && command !== "edit") {
    throw new Error(`Lệnh không hợp lệ '${command}'. Dùng 'generate' hoặc 'edit'.`);
  }

  const opts = {
    command,
    prompt: "",
    ratio: "",
    size: "",
    model: "gemini/4-hydrogen",
    out: "",
    threadId: process.env.CODEX_THREAD_ID?.trim() || "",
    baseUrl: "",
    images: [],
  };

  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    const takeValue = () => {
      if (next === undefined) {
        throw new Error(`Thiếu giá trị cho tham số ${flag}`);
      }
      i += 1;
      return next;
    };

    switch (flag) {
      case "--prompt":
      case "-p":
        opts.prompt = takeValue();
        break;
      case "--ratio":
      case "-r":
        opts.ratio = takeValue().trim();
        break;
      case "--size":
      case "-s":
        opts.size = takeValue().trim();
        break;
      case "--model":
      case "-m":
        opts.model = takeValue().trim();
        break;
      case "--out":
      case "-o":
        opts.out = takeValue().trim();
        break;
      case "--thread-id":
      case "-t":
        opts.threadId = takeValue().trim();
        break;
      case "--base-url":
        opts.baseUrl = takeValue().trim();
        break;
      case "--image":
      case "-i":
        opts.images.push(takeValue().trim());
        break;
      case "-h":
      case "--help":
        return { help: true };
      default:
        throw new Error(`Tham số không hỗ trợ: ${flag}`);
    }
  }

  if (!opts.prompt.trim()) {
    throw new Error("Thiếu --prompt (mô tả ảnh cần tạo hoặc chỉnh sửa).");
  }
  if (opts.ratio && !SUPPORTED_RATIOS.has(opts.ratio)) {
    throw new Error(`Tỉ lệ '${opts.ratio}' không hợp lệ. Hỗ trợ: 1:1, 16:9, 9:16, 4:3, 3:4.`);
  }
  if (command === "edit" && opts.images.length === 0) {
    throw new Error("Lệnh 'edit' yêu cầu ít nhất một --image nguồn.");
  }
  if (opts.images.length > 3) {
    throw new Error("Gemini Web chỉ hỗ trợ tối đa 3 ảnh đầu vào mỗi lượt.");
  }

  return opts;
}

function buildPromptWithRatio(prompt, ratio) {
  const clean = prompt.trim();
  if (!ratio || ratio === "1:1") return clean;
  const escaped = ratio.replace(":", "\\:");
  const exists = new RegExp(`(?:^|[\\s(,;\\[])${escaped}(?=$|[\\s),.;\\]!?])`, "i").test(clean);
  return exists ? clean : `${clean}\n\nPreferred aspect ratio: ${ratio}.`;
}

function detectImageMimeType(filePath, buffer) {
  if (buffer.length >= 8 && buffer.toString("hex", 0, 8) === "89504e470d0a1a0a") {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function readImageDimensions(buffer, mimeType) {
  if (mimeType === "image/png" && buffer.length >= 24 && buffer.toString("hex", 0, 8) === "89504e470d0a1a0a") {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  return { width: null, height: null };
}

function resolveOutputPath(explicitOut, mimeType) {
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  if (explicitOut) {
    const resolved = resolve(expandHome(explicitOut));
    mkdirSync(dirname(resolved), { recursive: true });
    return resolved;
  }
  const outDir = join(getCodexHomeDir(), "generated_images", "gemini-image");
  mkdirSync(outDir, { recursive: true });
  return join(outDir, `gemini-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(
      [
        "Sử dụng:",
        "  node gemini-image.mjs generate --prompt \"...\" [--ratio 16:9] [--out file.png] [--thread-id id]",
        "  node gemini-image.mjs edit --image src.png --prompt \"...\" [--ratio 16:9] [--out file.png] [--thread-id id]",
      ].join("\n"),
    );
    return;
  }

  const baseUrl = resolveBridgeBaseUrl(parsed.baseUrl);
  const endpoint = parsed.command === "edit" ? `${baseUrl}/v1/images/edits` : `${baseUrl}/v1/images/generations`;
  const finalPrompt = buildPromptWithRatio(parsed.prompt, parsed.ratio);

  const body = {
    model: parsed.model || "gemini/4-hydrogen",
    prompt: finalPrompt,
    ...(parsed.size ? { size: parsed.size } : {}),
    output_format: "png",
  };

  if (parsed.command === "edit") {
    body.images = parsed.images.map((rawPath) => {
      const absPath = resolve(expandHome(rawPath));
      if (!existsSync(absPath)) {
        throw new Error(`Không tìm thấy file ảnh nguồn: ${absPath}`);
      }
      const buf = readFileSync(absPath);
      if (buf.length === 0) {
        throw new Error(`File ảnh nguồn bị rỗng: ${absPath}`);
      }
      const mime = detectImageMimeType(absPath, buf);
      return { image_url: `data:${mime};base64,${buf.toString("base64")}` };
    });
  }

  const headers = { "content-type": "application/json" };
  if (parsed.threadId) {
    headers["x-codex-turn-metadata"] = JSON.stringify({
      thread_id: parsed.threadId,
      model: body.model,
    });
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    const cause = error && typeof error === "object" && "cause" in error ? error.cause : undefined;
    const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
    const detail = error instanceof Error ? error.message : String(error);
    if (code === "EPERM" || code === "EACCES") {
      throw new Error(
        `SANDBOX_BLOCKED (${code}): Sandbox hiện tại chặn kết nối tới ${endpoint}. Hãy chạy lại exec_command với sandbox_permissions: "require_escalated" (hoặc bật network_access = true trong [sandbox_workspace_write]).`,
      );
    }
    if (code === "ECONNREFUSED") {
      throw new Error(
        `BRIDGE_UNREACHABLE (${code}): Không kết nối được bridge tại ${endpoint}. Hãy kiểm tra ứng dụng codex-chatgpt-web đã bật chưa.`,
      );
    }
    throw new Error(`Không gọi được ${endpoint}${code ? ` (${code})` : ""}: ${detail}`);
  }

  const rawText = await response.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error(`Phản hồi từ ${endpoint} không phải JSON hợp lệ (HTTP ${response.status}): ${rawText.slice(0, 300)}`);
  }

  if (!response.ok) {
    const errMsg = json?.error?.message || rawText.slice(0, 300);
    throw new Error(`Lỗi từ bridge HTTP ${response.status}: ${errMsg}`);
  }

  const b64 = json?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64.trim()) {
    throw new Error("Bridge trả về 200 nhưng thiếu dữ liệu ảnh data[0].b64_json.");
  }

  const outBuffer = Buffer.from(b64, "base64");
  const outMime =
    json?.output_format === "jpeg"
      ? "image/jpeg"
      : json?.output_format === "webp"
        ? "image/webp"
        : detectImageMimeType("output.png", outBuffer);
  const outPath = resolveOutputPath(parsed.out, outMime);
  writeFileSync(outPath, outBuffer);

  const dims = readImageDimensions(outBuffer, outMime);
  console.log(
    JSON.stringify(
      {
        ok: true,
        path: outPath,
        mimeType: outMime,
        bytes: outBuffer.length,
        width: dims.width,
        height: dims.height,
        revisedPrompt: json?.data?.[0]?.revised_prompt ?? finalPrompt,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[gemini-image] ${message}`);
  process.exit(1);
});
