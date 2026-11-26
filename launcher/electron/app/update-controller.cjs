const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const REPOSITORY = "huytvdev22/codex-chatgpt-web";
const RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const USER_AGENT = "codex-web-gpt-launcher-updater";
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_PROGRESS_THROTTLE_MS = 180;

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Invalid release version comparison: ${left} / ${right}`);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function releaseVersion(tagName) {
  const version = String(tagName || "").replace(/^v/, "");
  if (!parseVersion(version)) throw new Error(`GitHub returned an invalid release tag: ${tagName}`);
  return version;
}

function releaseAssetName(version, platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) {
    return `codex-m365-copilot-${version}-mac-${arch}.zip`;
  }
  if (platform === "win32" && arch === "x64") {
    return `codex-m365-copilot-${version}-win-x64.exe`;
  }
  if (platform === "linux" && ["x64", "arm64"].includes(arch)) {
    return `codex-m365-copilot-${version}-linux-${arch}.AppImage`;
  }
  return null;
}

function expectedChecksum(contents, assetName) {
  for (const line of String(contents || "").split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2].trim() === assetName) return match[1].toLowerCase();
  }
  throw new Error(`checksums.txt has no entry for ${assetName}`);
}

function validateReleaseAssetUrl(raw, version, assetName) {
  const url = new URL(raw);
  const expectedPath = `/${REPOSITORY}/releases/download/v${version}/${assetName}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath) {
    throw new Error(`GitHub returned an unexpected release asset URL for ${assetName}`);
  }
  return url.toString();
}

function createAbortError() {
  const error = new Error("Update download aborted");
  error.name = "AbortError";
  return error;
}

function request(url, { redirects = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    if (redirects > MAX_REDIRECTS) {
      reject(new Error(`Too many redirects while downloading ${url}`));
      return;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      reject(new Error(`Refusing non-HTTPS update URL: ${parsed.protocol}`));
      return;
    }
    const req = https.get(parsed, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
    }, (response) => {
      cleanupAbort();
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, parsed).toString();
        request(next, { redirects: redirects + 1, signal }).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Update download failed with HTTP ${response.statusCode}`));
        return;
      }
      resolve(response);
    });

    const onAbort = () => {
      req.destroy(createAbortError());
    };
    const cleanupAbort = () => {
      signal?.removeEventListener?.("abort", onAbort);
    };

    signal?.addEventListener?.("abort", onAbort, { once: true });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Update request timed out")));
    req.once("error", (error) => {
      cleanupAbort();
      reject(error);
    });
  });
}

async function downloadText(url, maxBytes = 2 * 1024 * 1024) {
  const response = await request(url);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Update metadata exceeded its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function downloadFile(url, destination, { signal, onProgress, totalBytesHint = 0 } = {}) {
  const response = await request(url, { signal });
  const headerTotal = Number(response.headers?.["content-length"] || 0);
  const totalBytes = headerTotal > 0 ? headerTotal : Number(totalBytesHint || 0);
  const writeStream = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const hash = crypto.createHash("sha256");
  const startedAt = Date.now();
  let bytesDownloaded = 0;
  let lastEmitAt = 0;

  const onAbort = () => {
    response.destroy(createAbortError());
    writeStream.destroy();
  };
  signal?.addEventListener?.("abort", onAbort, { once: true });

  try {
    for await (const chunk of response) {
      if (signal?.aborted) throw createAbortError();
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      bytesDownloaded += buf.length;
      await new Promise((resolve, reject) => {
        writeStream.write(buf, (err) => (err ? reject(err) : resolve()));
      });

      const now = Date.now();
      if (typeof onProgress === "function" && now - lastEmitAt >= DOWNLOAD_PROGRESS_THROTTLE_MS) {
        lastEmitAt = now;
        const elapsedSec = Math.max(0.1, (now - startedAt) / 1000);
        const percent = totalBytes > 0
          ? Math.min(99, Math.round((bytesDownloaded / totalBytes) * 100))
          : 0;
        onProgress({
          percent,
          bytesDownloaded,
          totalBytes,
          speedBytesPerSec: Math.round(bytesDownloaded / elapsedSec),
        });
      }
    }
    await new Promise((resolve, reject) => {
      writeStream.once("error", reject);
      writeStream.end(resolve);
    });
    return {
      sha256: hash.digest("hex").toLowerCase(),
      bytesDownloaded,
      totalBytes: totalBytes || bytesDownloaded,
    };
  } catch (error) {
    writeStream.destroy();
    throw error;
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
  }
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function macApplicationPath(executablePath) {
  const match = /^(.*\.app)[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/.exec(String(executablePath || ""));
  if (!match?.[1]) throw new Error(`Could not resolve the macOS application bundle from ${executablePath}`);
  return match[1];
}

function isMacAppTranslocated(appBundlePath) {
  return Boolean(appBundlePath && String(appBundlePath).includes("/AppTranslocation/"));
}

function canWriteDirectory(dirPath) {
  if (!dirPath) return false;
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function decodeXmlEntities(text) {
  return String(text)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function resolveMacAppExecutableName(appBundlePath) {
  const plistPath = path.join(appBundlePath, "Contents", "Info.plist");
  if (fs.existsSync(plistPath)) {
    try {
      const raw = fs.readFileSync(plistPath, "utf8");
      const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/i.exec(raw);
      if (match?.[1]?.trim()) {
        return decodeXmlEntities(match[1].trim());
      }
    } catch {}
    if (process.platform === "darwin") {
      try {
        const res = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
          encoding: "utf8",
          timeout: 5_000,
        });
        if (res.status === 0 && res.stdout) {
          const parsed = JSON.parse(res.stdout);
          if (typeof parsed?.CFBundleExecutable === "string" && parsed.CFBundleExecutable.trim()) {
            return parsed.CFBundleExecutable.trim();
          }
        }
      } catch {}
    }
  }
  const macOsDir = path.join(appBundlePath, "Contents", "MacOS");
  if (fs.existsSync(macOsDir)) {
    const entries = fs.readdirSync(macOsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile());
    if (entries.length === 1) return entries[0].name;
    const bundleBase = path.basename(appBundlePath, ".app");
    const exact = entries.find((entry) => entry.name === bundleBase);
    if (exact) return exact.name;
    if (entries.length > 0) return entries[0].name;
  }
  return null;
}

function findMacApplication(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!appEntry) throw new Error("The macOS update archive does not contain an application bundle");
  const application = path.join(root, appEntry.name);
  const executableName = resolveMacAppExecutableName(application);
  if (!executableName) {
    throw new Error("The macOS update archive does not specify an executable");
  }
  const executable = path.join(application, "Contents", "MacOS", executableName);
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error("The macOS update archive is incomplete");
  }
  return application;
}

function linuxUpdateInstallation() {
  const guidance = "Quit Codex M365 Copilot, run install-launcher.sh from the README once, then reopen the installed app. Your settings and browser profile are preserved.";
  const target = process.env.CODEX_WEB_GPT_APPIMAGE?.trim()
    || process.env.APPIMAGE?.trim();
  if (!target || !path.isAbsolute(target)) {
    throw new Error(`The running Linux AppImage path is unavailable. ${guidance}`);
  }
  const wrapper = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE?.trim();
  if (!wrapper || !path.isAbsolute(wrapper)) {
    throw new Error(`Linux auto-update requires the stable install-launcher.sh wrapper. ${guidance}`);
  }
  return { target, wrapper };
}

function buildJob({ version, platform, executablePath, assetPath, stagingRoot, tempRoot, logPath }) {
  if (platform === "darwin") {
    const source = findMacApplication(stagingRoot);
    const executableName = resolveMacAppExecutableName(source)
      || (executablePath ? path.basename(executablePath) : null);
    return {
      version,
      platform,
      parentPid: process.pid,
      tempRoot,
      logPath,
      source,
      executableName,
      target: macApplicationPath(executablePath),
    };
  }
  if (platform === "win32") {
    return {
      version,
      platform,
      parentPid: process.pid,
      tempRoot,
      logPath,
      source: assetPath,
      target: executablePath,
    };
  }
  if (platform === "linux") {
    const { target, wrapper } = linuxUpdateInstallation();
    return {
      version,
      platform,
      parentPid: process.pid,
      tempRoot,
      logPath,
      source: assetPath,
      target,
      wrapper,
      runnerSource: path.join(tempRoot, "linux-appimage-runner.sh"),
    };
  }
  throw new Error(`Updates are not supported on ${platform}`);
}

function defaultDependencies() {
  return {
    fetchRelease: async () => JSON.parse(await downloadText(RELEASE_API_URL)),
    downloadText,
    downloadFile,
    sha256,
    extractMac(archive, destination) {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      const result = spawnSync("/usr/bin/ditto", ["-x", "-k", archive, destination], {
        encoding: "utf8",
        timeout: 120_000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Could not extract the macOS update: ${result.stderr.trim()}`);
    },
    verifyMacBundle(stagedAppPath) {
      if (process.platform !== "darwin") return;
      const result = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedAppPath], {
        encoding: "utf8",
        timeout: 60_000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`macOS update signature verification failed: ${(result.stderr || "").trim() || "unknown error"}`);
      }
      spawnSync("/usr/bin/xattr", ["-cr", stagedAppPath], {
        encoding: "utf8",
        timeout: 30_000,
      });
    },
    canInstallMacSelfReplace(executablePath) {
      try {
        const appPath = macApplicationPath(executablePath);
        if (isMacAppTranslocated(appPath)) return false;
        return canWriteDirectory(path.dirname(appPath));
      } catch {
        return false;
      }
    },
    linuxRunnerSource() {
      if (typeof process.resourcesPath === "string" && process.resourcesPath) {
        const unpacked = path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "assets",
          "linux-appimage-runner.sh",
        );
        if (fs.statSync(unpacked, { throwIfNoEntry: false })?.isFile()) return unpacked;
      }
      const source = path.resolve(__dirname, "../..", "assets", "linux-appimage-runner.sh");
      if (fs.statSync(source, { throwIfNoEntry: false })?.isFile()) return source;
      throw new Error("Packaged Linux AppImage runner is missing");
    },
    spawnWorker(runtimeExecutable, workerPath, jobPath) {
      return spawn(runtimeExecutable, [workerPath, jobPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    },
  };
}

/**
 * Service quản lý kiểm tra, tải về (streaming + SHA-256) và bàn giao cài đặt bản cập nhật.
 */
class AppUpdaterService {
  constructor({
    currentVersion,
    platform = process.platform,
    arch = process.arch,
    packaged = false,
    executablePath = process.execPath,
    runtimeExecutable = null,
    logsDirectory = os.tmpdir(),
    updatesDirectory = null,
    settingsStore = null,
    shell = null,
    publish = null,
    onSettingsChanged = null,
    onNotify = null,
    logger = null,
    dependencies = {},
  }) {
    this.currentVersion = currentVersion;
    this.platform = platform;
    this.arch = arch;
    this.packaged = Boolean(packaged);
    this.executablePath = executablePath;
    this.runtimeExecutable = runtimeExecutable;
    this.logsDirectory = logsDirectory;
    this.updatesDirectory = updatesDirectory || path.join(os.tmpdir(), "codex-web-gpt-updates");
    this.settingsStore = settingsStore;
    this.shell = shell;
    this.publish = publish;
    this.onSettingsChanged = onSettingsChanged;
    this.onNotify = onNotify;
    this.logger = logger;
    this.deps = { ...defaultDependencies(), ...dependencies };

    this.supportedAsset = releaseAssetName(currentVersion, platform, arch);
    this.enabled = Boolean(this.packaged && this.supportedAsset);
    this.checkedOnStartup = false;
    this.pendingDownload = null;
    this.pendingInstall = null;
    this.downloadAbortController = null;
    this.candidate = null;
    this.notifiedVersions = new Set();

    const initialSettings = this.getSettings();
    this.state = {
      status: this.enabled ? "idle" : "disabled",
      currentVersion: this.currentVersion,
      platform: this.platform,
      arch: this.arch,
      packaged: this.packaged,
      availableRelease: null,
      progress: null,
      downloadedFilePath: null,
      verifiedSha256: null,
      lastCheckedAt: initialSettings.lastCheckedAt || null,
    };
  }

  getState() {
    return structuredClone(this.state);
  }

  getSettings() {
    if (!this.settingsStore) {
      return {
        version: 1,
        autoCheckOnStartup: true,
        ignoredVersion: null,
        lastCheckedAt: null,
      };
    }
    return this.settingsStore.getSettings();
  }

  saveSettings(patch = {}) {
    if (!this.settingsStore) {
      const next = { ...this.getSettings(), ...patch };
      this.onSettingsChanged?.(next);
      return next;
    }
    const updated = this.settingsStore.saveSettings(patch);
    this.onSettingsChanged?.(updated);
    return updated;
  }

  transition(nextState) {
    this.state = nextState;
    this.publish?.(this.getState());
    return this.getState();
  }

  buildIdleStatePatch(overrides = {}) {
    return {
      status: "up-to-date",
      currentVersion: this.currentVersion,
      platform: this.platform,
      arch: this.arch,
      packaged: this.packaged,
      availableRelease: null,
      progress: null,
      downloadedFilePath: null,
      verifiedSha256: null,
      lastCheckedAt: this.getSettings().lastCheckedAt,
      ...overrides,
    };
  }

  async checkOnce() {
    if (!this.enabled || this.checkedOnStartup) return this.getState();
    this.checkedOnStartup = true;
    const settings = this.getSettings();
    if (!settings.autoCheckOnStartup) return this.getState();
    return this.checkForUpdates({ manual: false });
  }

  async checkForUpdates({ manual = false } = {}) {
    if (!this.enabled) return this.getState();
    if (["checking", "downloading", "installing"].includes(this.state.status)) {
      return this.getState();
    }

    const previousCandidate = this.candidate;
    const previousDownloadedPath = this.state.downloadedFilePath;
    const previousVerifiedSha = this.state.verifiedSha256;

    this.transition({
      ...this.state,
      status: "checking",
      message: undefined,
    });

    try {
      const release = await this.deps.fetchRelease();
      const checkedAt = new Date().toISOString();
      if (this.settingsStore) {
        this.saveSettings({ lastCheckedAt: checkedAt });
      }

      if (!release || release.draft === true || release.prerelease === true) {
        this.candidate = null;
        return this.transition(this.buildIdleStatePatch({ lastCheckedAt: checkedAt }));
      }

      const version = releaseVersion(release.tag_name);
      if (compareVersions(version, this.currentVersion) <= 0) {
        this.candidate = null;
        return this.transition(this.buildIdleStatePatch({ lastCheckedAt: checkedAt }));
      }

      const ignoredVersion = this.getSettings().ignoredVersion;
      if (!manual && ignoredVersion && ignoredVersion === version) {
        this.candidate = null;
        return this.transition(this.buildIdleStatePatch({ lastCheckedAt: checkedAt }));
      }

      const assetName = releaseAssetName(version, this.platform, this.arch);
      if (!assetName) {
        this.candidate = null;
        return this.transition({
          status: "disabled",
          currentVersion: this.currentVersion,
          platform: this.platform,
          arch: this.arch,
          packaged: this.packaged,
          availableRelease: null,
          progress: null,
          downloadedFilePath: null,
          verifiedSha256: null,
          lastCheckedAt: checkedAt,
        });
      }

      const assets = Array.isArray(release.assets) ? release.assets : [];
      const asset = assets.find((item) => item?.name === assetName);
      const checksums = assets.find((item) => item?.name === "checksums.txt");
      if (!asset?.browser_download_url || !checksums?.browser_download_url) {
        throw new Error(`Release v${version} is missing ${assetName} or checksums.txt`);
      }

      const assetUrl = validateReleaseAssetUrl(asset.browser_download_url, version, assetName);
      const checksumsUrl = validateReleaseAssetUrl(checksums.browser_download_url, version, "checksums.txt");

      const availableRelease = {
        version,
        tagName: String(release.tag_name || `v${version}`),
        name: String(release.name || release.tag_name || `v${version}`),
        notes: String(release.body || "").trim(),
        publishedAt: release.published_at || null,
        htmlUrl: release.html_url || null,
        assetName,
        assetSize: Number(asset.size || 0),
        assetUrl,
        checksumsUrl,
      };

      this.candidate = {
        version,
        assetName,
        assetUrl,
        checksumsUrl,
        assetSize: availableRelease.assetSize,
      };

      const targetPath = path.join(this.updatesDirectory, version, path.basename(assetName));
      const alreadyDownloaded = Boolean(
        previousCandidate?.version === version
        && previousDownloadedPath === targetPath
        && fs.existsSync(targetPath)
        && previousVerifiedSha,
      );

      this.logger?.info?.("launcher.update_available", {
        currentVersion: this.currentVersion,
        version,
        platform: this.platform,
        arch: this.arch,
      });

      const nextState = this.transition({
        status: alreadyDownloaded ? "downloaded" : "available",
        version,
        currentVersion: this.currentVersion,
        platform: this.platform,
        arch: this.arch,
        packaged: this.packaged,
        availableRelease,
        progress: alreadyDownloaded ? {
          percent: 100,
          bytesDownloaded: availableRelease.assetSize,
          totalBytes: availableRelease.assetSize,
          speedBytesPerSec: 0,
        } : null,
        downloadedFilePath: alreadyDownloaded ? targetPath : null,
        verifiedSha256: alreadyDownloaded ? previousVerifiedSha : null,
        lastCheckedAt: checkedAt,
      });

      if (!alreadyDownloaded && !this.notifiedVersions.has(`available:${version}`)) {
        this.notifiedVersions.add(`available:${version}`);
        this.onNotify?.({ kind: "available", version, currentVersion: this.currentVersion });
      }

      return nextState;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.("launcher.update_check_failed", { message });
      return this.transition({
        ...this.state,
        status: "error",
        message,
      });
    }
  }

  async downloadUpdate() {
    if (!this.enabled) throw new Error("Launcher updates are unavailable");
    if (this.pendingDownload) return this.pendingDownload;
    if (this.state.status === "downloaded" && this.state.downloadedFilePath && fs.existsSync(this.state.downloadedFilePath)) {
      return this.getState();
    }
    if (!this.candidate) {
      throw new Error("No launcher update is available");
    }

    const available = this.candidate;
    const versionDir = path.join(this.updatesDirectory, available.version);
    fs.mkdirSync(versionDir, { recursive: true, mode: 0o700 });
    const targetPath = path.join(versionDir, path.basename(available.assetName));
    const partPath = `${targetPath}.part-${process.pid}-${Date.now()}`;

    const abortController = new AbortController();
    this.downloadAbortController = abortController;

    this.transition({
      ...this.state,
      status: "downloading",
      version: available.version,
      downloadedFilePath: null,
      verifiedSha256: null,
      message: undefined,
      progress: {
        percent: 0,
        bytesDownloaded: 0,
        totalBytes: available.assetSize || 0,
        speedBytesPerSec: 0,
      },
    });

    this.pendingDownload = (async () => {
      try {
        const checksums = await this.deps.downloadText(available.checksumsUrl);
        if (abortController.signal.aborted) throw createAbortError();
        const expected = expectedChecksum(checksums, available.assetName);

        let streamedSha = null;
        let bytesDownloaded = 0;
        let totalBytes = available.assetSize || 0;

        const downloadResult = await this.deps.downloadFile(available.assetUrl, partPath, {
          signal: abortController.signal,
          totalBytesHint: available.assetSize || 0,
          onProgress: (progress) => {
            if (abortController.signal.aborted) return;
            this.transition({
              ...this.state,
              status: "downloading",
              version: available.version,
              progress,
            });
          },
        });

        if (downloadResult && typeof downloadResult === "object") {
          streamedSha = downloadResult.sha256 || null;
          bytesDownloaded = Number(downloadResult.bytesDownloaded || 0);
          totalBytes = Number(downloadResult.totalBytes || totalBytes || bytesDownloaded);
        }

        const actual = String(this.deps.sha256 ? this.deps.sha256(partPath) : streamedSha || "").toLowerCase();
        if (!actual || actual !== expected) {
          throw new Error(`SHA-256 verification failed for ${available.assetName}`);
        }

        fs.rmSync(targetPath, { force: true });
        fs.renameSync(partPath, targetPath);
        if (this.platform === "linux") {
          fs.chmodSync(targetPath, 0o755);
        }
        const finalSize = bytesDownloaded || fs.statSync(targetPath).size;

        const doneState = this.transition({
          ...this.state,
          status: "downloaded",
          version: available.version,
          downloadedFilePath: targetPath,
          verifiedSha256: actual,
          message: undefined,
          progress: {
            percent: 100,
            bytesDownloaded: finalSize,
            totalBytes: totalBytes || finalSize,
            speedBytesPerSec: 0,
          },
        });

        if (!this.notifiedVersions.has(`downloaded:${available.version}`)) {
          this.notifiedVersions.add(`downloaded:${available.version}`);
          this.onNotify?.({ kind: "downloaded", version: available.version, currentVersion: this.currentVersion });
        }

        return doneState;
      } catch (error) {
        fs.rmSync(partPath, { force: true });
        const aborted = abortController.signal.aborted || error?.name === "AbortError";
        if (aborted) {
          return this.transition({
            ...this.state,
            status: "available",
            version: available.version,
            progress: null,
            downloadedFilePath: null,
            verifiedSha256: null,
            message: undefined,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn?.("launcher.update_download_failed", { message });
        return this.transition({
          ...this.state,
          status: "error",
          version: available.version,
          progress: null,
          downloadedFilePath: null,
          verifiedSha256: null,
          message,
        });
      } finally {
        if (this.downloadAbortController === abortController) {
          this.downloadAbortController = null;
        }
        this.pendingDownload = null;
      }
    })();

    return this.pendingDownload;
  }

  cancelDownload() {
    if (this.state.status === "downloading" && this.downloadAbortController) {
      this.downloadAbortController.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  async beginInstall() {
    if (this.pendingInstall) throw new Error("An update is already being prepared");
    if (!this.candidate) throw new Error("No launcher update is available");
    if (this.platform === "linux") linuxUpdateInstallation();

    const available = this.candidate;
    if (this.state.status === "available") {
      const downloaded = await this.downloadUpdate();
      if (downloaded.status !== "downloaded") {
        throw new Error(downloaded.message || "Update download did not complete");
      }
    }

    if (this.state.status !== "downloaded" || !this.state.downloadedFilePath || !fs.existsSync(this.state.downloadedFilePath)) {
      throw new Error("No verified launcher update package is ready to install");
    }

    const assetPath = this.state.downloadedFilePath;
    if (this.state.verifiedSha256) {
      const currentHash = String(this.deps.sha256(assetPath) || "").toLowerCase();
      if (currentHash !== this.state.verifiedSha256) {
        throw new Error(`SHA-256 verification failed for ${available.assetName}`);
      }
    }

    if (this.platform === "darwin" && this.deps.canInstallMacSelfReplace && !this.deps.canInstallMacSelfReplace(this.executablePath)) {
      if (this.shell?.openPath) {
        await this.shell.openPath(assetPath);
      } else {
        this.shell?.showItemInFolder?.(assetPath);
      }
      return {
        installed: false,
        mode: "mac-opened-file",
        filePath: assetPath,
        version: available.version,
        message: "Cannot overwrite the app from its current location (read-only or AppTranslocation). Opened the verified update package for manual installation.",
      };
    }

    this.pendingInstall = (async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-update-"));
      try {
        const stagingRoot = path.join(tempRoot, "stage");
        if (this.platform === "darwin") {
          this.deps.extractMac(assetPath, stagingRoot);
          const stagedApp = findMacApplication(stagingRoot);
          this.deps.verifyMacBundle?.(stagedApp);
        }
        if (this.platform === "linux") {
          fs.chmodSync(assetPath, 0o755);
          const runnerSource = this.deps.linuxRunnerSource();
          fs.copyFileSync(runnerSource, path.join(tempRoot, "linux-appimage-runner.sh"));
          fs.chmodSync(path.join(tempRoot, "linux-appimage-runner.sh"), 0o755);
        }

        const workerPath = path.join(tempRoot, "update-worker.cjs");
        fs.copyFileSync(path.join(__dirname, "update-worker.cjs"), workerPath);
        const job = buildJob({
          version: available.version,
          platform: this.platform,
          executablePath: this.executablePath,
          assetPath,
          stagingRoot,
          tempRoot,
          logPath: path.join(this.logsDirectory, "update-worker.log"),
        });
        const jobPath = path.join(tempRoot, "job.json");
        fs.writeFileSync(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });

        const child = this.deps.spawnWorker(this.runtimeExecutable, workerPath, jobPath);
        if (!Number.isInteger(child?.pid) || child.pid <= 0) {
          throw new Error("The update worker did not start");
        }
        child.unref?.();
        this.logger?.info?.("launcher.update_worker_started", {
          pid: child.pid,
          version: available.version,
        });
        this.transition({
          ...this.state,
          status: "installing",
          version: available.version,
        });
        return {
          installed: true,
          child,
          tempRoot,
          version: available.version,
        };
      } catch (error) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        this.transition({
          ...this.state,
          status: "downloaded",
          version: available.version,
        });
        throw error;
      }
    })();

    try {
      return await this.pendingInstall;
    } finally {
      this.pendingInstall = null;
    }
  }

  cancelInstall(launch) {
    try { launch?.child?.kill(); } catch {}
    if (launch?.tempRoot) fs.rmSync(launch.tempRoot, { recursive: true, force: true });
    if (this.candidate) {
      const nextStatus = this.state.downloadedFilePath && fs.existsSync(this.state.downloadedFilePath)
        ? "downloaded"
        : "available";
      this.transition({
        ...this.state,
        status: nextStatus,
        version: this.candidate.version,
      });
    }
  }

  openDownloadedFolder() {
    const filePath = this.state.downloadedFilePath;
    if (filePath && fs.existsSync(filePath)) {
      this.shell?.showItemInFolder?.(filePath);
      return { opened: true, filePath };
    }
    return { opened: false, filePath: null };
  }

  ignoreCurrentUpdate() {
    const version = this.candidate?.version || this.state.availableRelease?.version || null;
    if (!version) return this.getState();
    if (this.settingsStore) {
      this.saveSettings({ ignoredVersion: version });
    }
    this.candidate = null;
    return this.transition(this.buildIdleStatePatch());
  }
}

function createUpdateController(options) {
  return new AppUpdaterService(options);
}

module.exports = {
  AppUpdaterService,
  buildJob,
  canWriteDirectory,
  compareVersions,
  createUpdateController,
  expectedChecksum,
  findMacApplication,
  isMacAppTranslocated,
  macApplicationPath,
  parseVersion,
  releaseAssetName,
  releaseVersion,
  resolveMacAppExecutableName,
  validateReleaseAssetUrl,
};
