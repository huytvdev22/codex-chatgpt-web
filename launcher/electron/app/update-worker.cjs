const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function appendLog(job, message) {
  try {
    fs.mkdirSync(path.dirname(job.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(job.logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {}
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForParent(pid, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Launcher process ${pid} did not exit in time`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function launch(bin, args = [], { windowsHide = true } = {}) {
  const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide });
  child.unref();
}

function requireFile(filePath, label) {
  if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${filePath || "unknown"}`);
  }
}

function resolveMacExecutableName(appBundlePath, preferredName = null) {
  if (preferredName && typeof preferredName === "string") {
    const candidate = path.join(appBundlePath, "Contents", "MacOS", preferredName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return preferredName;
    }
  }
  const plistPath = path.join(appBundlePath, "Contents", "Info.plist");
  if (fs.existsSync(plistPath)) {
    try {
      const raw = fs.readFileSync(plistPath, "utf8");
      const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/i.exec(raw);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    } catch {}
  }
  const macOsDir = path.join(appBundlePath, "Contents", "MacOS");
  if (fs.existsSync(macOsDir)) {
    const entries = fs.readdirSync(macOsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile());
    if (entries.length > 0) return entries[0].name;
  }
  return null;
}

function updateMac(job) {
  const executableName = resolveMacExecutableName(job.source, job.executableName);
  if (!executableName) {
    throw new Error("Staged macOS launcher executable could not be resolved");
  }
  const sourceExecutable = path.join(job.source, "Contents", "MacOS", executableName);
  requireFile(sourceExecutable, "Staged macOS launcher");

  const next = `${job.target}.updating-${process.pid}`;
  const previous = `${job.target}.swap-${process.pid}`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.rmSync(previous, { recursive: true, force: true });

  const copied = spawnSync("/usr/bin/ditto", [job.source, next], { encoding: "utf8", timeout: 180_000 });
  if (copied.error) throw copied.error;
  if (copied.status !== 0) throw new Error(`Could not stage the macOS application: ${copied.stderr.trim()}`);
  requireFile(path.join(next, "Contents", "MacOS", executableName), "Copied macOS launcher");

  fs.renameSync(job.target, previous);
  try {
    fs.renameSync(next, job.target);
  } catch (error) {
    fs.renameSync(previous, job.target);
    throw error;
  }
  fs.rmSync(previous, { recursive: true, force: true });
  if (process.platform === "darwin") {
    spawnSync("/usr/bin/xattr", ["-cr", job.target], { encoding: "utf8", timeout: 30_000 });
  }
  launch("/usr/bin/open", [job.target]);
}

function updateWindows(job) {
  requireFile(job.source, "Windows installer");
  // Mở trình cài đặt GUI (.exe) để người dùng chủ động bấm Next như daily-podcast-studio.
  launch(job.source, [], { windowsHide: false });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function installLinuxFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const next = `${target}.updating-${process.pid}`;
  fs.rmSync(next, { force: true });
  fs.copyFileSync(source, next);
  fs.chmodSync(next, 0o755);
  fs.renameSync(next, target);
}

function updateLinux(job) {
  requireFile(job.source, "Linux AppImage");
  requireFile(job.runnerSource, "Linux AppImage runner");
  const wrapper = job.wrapper && path.isAbsolute(job.wrapper) ? job.wrapper : null;
  if (!wrapper) throw new Error("Linux update job requires an absolute stable launcher wrapper");
  const versionsRoot = path.dirname(path.dirname(job.target));
  const nextTarget = path.join(versionsRoot, job.version, path.basename(job.target));
  const runner = path.join(versionsRoot, "run-appimage");
  installLinuxFile(job.source, nextTarget);
  installLinuxFile(job.runnerSource, runner);
  const wrapperNext = `${wrapper}.updating-${process.pid}`;
  fs.writeFileSync(wrapperNext, [
    "#!/bin/sh",
    "set -eu",
    `export CODEX_WEB_GPT_LAUNCHER_EXECUTABLE=${shellQuote(wrapper)}`,
    `export CODEX_WEB_GPT_APPIMAGE=${shellQuote(nextTarget)}`,
    `exec ${shellQuote(runner)} ${shellQuote(nextTarget)} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  fs.renameSync(wrapperNext, wrapper);
  if (path.dirname(job.target) !== path.dirname(nextTarget)
    && path.dirname(path.dirname(job.target)) === versionsRoot) {
    fs.rmSync(path.dirname(job.target), { recursive: true, force: true });
  }
  launch(wrapper);
}

function relaunchExisting(job) {
  try {
    if (job.platform === "darwin" && fs.existsSync(job.target)) launch("/usr/bin/open", [job.target]);
    else if (job.platform === "win32" && fs.existsSync(job.target)) launch(job.target);
    else if (job.platform === "linux") {
      const target = job.wrapper && fs.existsSync(job.wrapper) ? job.wrapper : job.target;
      if (fs.existsSync(target)) launch(target);
    }
  } catch {}
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath || !path.isAbsolute(jobPath)) throw new Error("Update worker requires an absolute job path");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  appendLog(job, `waiting for launcher PID ${job.parentPid} before installing v${job.version}`);
  await waitForParent(job.parentPid);
  appendLog(job, `installing v${job.version} on ${job.platform}`);
  try {
    if (job.platform === "darwin") updateMac(job);
    else if (job.platform === "win32") updateWindows(job);
    else if (job.platform === "linux") updateLinux(job);
    else throw new Error(`Unsupported update platform: ${job.platform}`);
    appendLog(job, `v${job.version} installed and relaunched`);
    try { fs.rmSync(job.tempRoot, { recursive: true, force: true }); } catch {}
  } catch (error) {
    appendLog(job, `update failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    relaunchExisting(job);
    throw error;
  }
}

void main().catch(() => process.exit(1));
