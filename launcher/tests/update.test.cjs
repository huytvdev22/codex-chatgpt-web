const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  buildJob,
  compareVersions,
  createUpdateController,
  expectedChecksum,
  findMacApplication,
  isMacAppTranslocated,
  macApplicationPath,
  releaseAssetName,
  resolveMacAppExecutableName,
  validateReleaseAssetUrl,
} = require("../electron/app/update-controller.cjs");
const { UpdaterSettingsStore } = require("../electron/app/updater-settings-store.cjs");

test("Linux auto-update fails closed without the stable installer wrapper", () => {
  const previousAppImage = process.env.CODEX_WEB_GPT_APPIMAGE;
  const previousWrapper = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
  process.env.CODEX_WEB_GPT_APPIMAGE = "/opt/codex/Codex Web GPT.AppImage";
  delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
  try {
    assert.throws(() => buildJob({
      version: "1.2.0",
      platform: "linux",
      executablePath: "/tmp/transient",
      assetPath: "/tmp/update.AppImage",
      stagingRoot: "/tmp/stage",
      tempRoot: "/tmp/update",
      logPath: "/tmp/update.log",
    }), /requires the stable install-launcher\.sh wrapper/);
  } finally {
    if (previousAppImage === undefined) delete process.env.CODEX_WEB_GPT_APPIMAGE;
    else process.env.CODEX_WEB_GPT_APPIMAGE = previousAppImage;
    if (previousWrapper === undefined) delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
    else process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = previousWrapper;
  }
});

test("unsupported Linux launches reject updates before downloading or changing state", async () => {
  const keys = ["CODEX_WEB_GPT_APPIMAGE", "APPIMAGE", "CODEX_WEB_GPT_LAUNCHER_EXECUTABLE"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const [appImage, wrapper] of [
      [undefined, "/opt/codex/launcher"],
      ["relative.AppImage", "/opt/codex/launcher"],
      ["/opt/codex/app.AppImage", undefined],
      ["/opt/codex/app.AppImage", "relative-launcher"],
    ]) {
      for (const key of keys) delete process.env[key];
      if (appImage !== undefined) process.env.CODEX_WEB_GPT_APPIMAGE = appImage;
      if (wrapper !== undefined) process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = wrapper;
      const calls = [];
      const states = [];
      const controller = createUpdateController({
        currentVersion: "1.1.4", platform: "linux", arch: "x64", packaged: true,
        publish: state => states.push(state.status),
        dependencies: {
          fetchRelease: async () => ({
            tag_name: "v1.2.0",
            assets: ["codex-m365-copilot-1.2.0-linux-x64.AppImage", "checksums.txt"].map(name => ({
              name,
              browser_download_url: `https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/${name}`,
            })),
          }),
          downloadText: async () => { calls.push("checksums"); throw new Error("Unexpected download"); },
          downloadFile: async () => { calls.push("asset"); },
          spawnWorker: () => { calls.push("worker"); },
        },
      });
      await controller.checkOnce();
      await assert.rejects(controller.beginInstall(), /install-launcher\.sh/);
      assert.deepEqual(calls, []);
      assert.deepEqual(states, ["checking", "available"]);
      assert.equal(controller.getState().status, "available");
      assert.equal(controller.getState().version, "1.2.0");
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("release comparison and platform assets are strict", () => {
  assert.equal(compareVersions("1.1.5", "1.1.4"), 1);
  assert.equal(compareVersions("1.1.4", "1.1.4"), 0);
  assert.equal(compareVersions("1.1.3", "1.1.4"), -1);
  assert.equal(compareVersions("1.2.0", "1.1.99"), 1);
  assert.equal(releaseAssetName("1.2.0", "darwin", "arm64"), "codex-m365-copilot-1.2.0-mac-arm64.zip");
  assert.equal(releaseAssetName("1.2.0", "darwin", "x64"), "codex-m365-copilot-1.2.0-mac-x64.zip");
  assert.equal(releaseAssetName("1.2.0", "win32", "x64"), "codex-m365-copilot-1.2.0-win-x64.exe");
  assert.equal(releaseAssetName("1.2.0", "linux", "x64"), "codex-m365-copilot-1.2.0-linux-x64.AppImage");
  assert.equal(releaseAssetName("1.2.0", "linux", "arm64"), "codex-m365-copilot-1.2.0-linux-arm64.AppImage");
  assert.equal(releaseAssetName("1.2.0", "linux", "arm"), null);
  assert.equal(releaseAssetName("1.2.0", "linux", "ia32"), null);
});

test("checksums and release URLs bind the exact expected asset", () => {
  const hash = "a".repeat(64);
  assert.equal(expectedChecksum(`${hash}  launcher.zip\n`, "launcher.zip"), hash);
  assert.throws(() => expectedChecksum(`${hash}  other.zip\n`, "launcher.zip"), /no entry/);
  assert.equal(
    validateReleaseAssetUrl(
      "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/launcher.zip",
      "1.2.0",
      "launcher.zip",
    ),
    "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/launcher.zip",
  );
  assert.throws(
    () => validateReleaseAssetUrl("https://example.com/launcher.zip", "1.2.0", "launcher.zip"),
    /unexpected release asset URL/,
  );
});

test("macOS bundle resolution resolves CFBundleExecutable dynamically without hardcoding Codex Web GPT", () => {
  assert.equal(
    macApplicationPath("/Applications/Codex M365 Copilot.app/Contents/MacOS/Codex M365 Copilot"),
    "/Applications/Codex M365 Copilot.app",
  );
  assert.throws(() => macApplicationPath("/tmp/Codex M365 Copilot"), /Could not resolve/);
  assert.equal(
    isMacAppTranslocated("/private/var/folders/xx/AppTranslocation/1234/d/Codex M365 Copilot.app"),
    true,
  );
  assert.equal(isMacAppTranslocated("/Applications/Codex M365 Copilot.app"), false);

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mac-bundle-test-"));
  try {
    const appDir = path.join(stage, "Codex M365 Copilot.app");
    const macOsDir = path.join(appDir, "Contents", "MacOS");
    fs.mkdirSync(macOsDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Codex M365 Copilot</string></dict></plist>`,
    );
    fs.writeFileSync(path.join(macOsDir, "Codex M365 Copilot"), "binary");
    assert.equal(resolveMacAppExecutableName(appDir), "Codex M365 Copilot");
    assert.equal(findMacApplication(stage), appDir);

    const job = buildJob({
      version: "6.14.0",
      platform: "darwin",
      executablePath: "/Applications/Codex M365 Copilot.app/Contents/MacOS/Codex M365 Copilot",
      assetPath: "/tmp/update.zip",
      stagingRoot: stage,
      tempRoot: "/tmp/update-temp",
      logPath: "/tmp/update.log",
    });
    assert.equal(job.executableName, "Codex M365 Copilot");
    assert.equal(job.target, "/Applications/Codex M365 Copilot.app");
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test("startup check runs once, exposes release notes, and respects disabled/autoCheckOnStartup", async () => {
  const disabledController = createUpdateController({
    currentVersion: "1.1.4",
    platform: "linux",
    arch: "x64",
    packaged: false,
    dependencies: {
      fetchRelease: async () => { throw new Error("Should not fetch in dev mode"); },
    },
  });
  assert.equal((await disabledController.checkOnce()).status, "disabled");
  assert.equal((await disabledController.checkForUpdates({ manual: true })).status, "disabled");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-updater-settings-"));
  try {
    const settingsStore = new UpdaterSettingsStore(root);
    let calls = 0;
    const notifications = [];
    const published = [];
    const controller = createUpdateController({
      currentVersion: "1.1.4",
      platform: "linux",
      arch: "x64",
      packaged: true,
      executablePath: "/tmp/launcher",
      runtimeExecutable: "/tmp/bun",
      logsDirectory: path.join(root, "logs"),
      updatesDirectory: path.join(root, "updates"),
      settingsStore,
      publish: (state) => published.push(state),
      onNotify: (event) => notifications.push(event),
      dependencies: {
        fetchRelease: async () => {
          calls += 1;
          return {
            tag_name: "v1.2.0",
            name: "Release v1.2.0",
            body: "## What's New\n- Faster bridge",
            published_at: "2026-11-26T10:00:00Z",
            html_url: "https://github.com/huytvdev22/codex-chatgpt-web/releases/tag/v1.2.0",
            assets: [
              {
                name: "codex-m365-copilot-1.2.0-linux-x64.AppImage",
                size: 123456,
                browser_download_url: "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/codex-m365-copilot-1.2.0-linux-x64.AppImage",
              },
              {
                name: "checksums.txt",
                browser_download_url: "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/checksums.txt",
              },
            ],
          };
        },
      },
    });
    const first = await controller.checkOnce();
    assert.equal(first.status, "available");
    assert.equal(first.version, "1.2.0");
    assert.equal(first.availableRelease.notes, "## What's New\n- Faster bridge");
    assert.equal(first.availableRelease.assetSize, 123456);
    assert.equal((await controller.checkOnce()).status, "available");
    assert.equal(calls, 1);
    assert.deepEqual(published.map((state) => state.status), ["checking", "available"]);
    assert.deepEqual(notifications, [{ kind: "available", version: "1.2.0", currentVersion: "1.1.4" }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preview and draft releases stay hidden until promoted, regardless of the version suffix", async () => {
  for (const tag of ["1.2.0", "1.2.0-rc.1"]) {
    for (const flags of [{ prerelease: true }, { draft: true }, { prerelease: false, draft: false }]) {
      const controller = createUpdateController({
        currentVersion: "1.1.4", platform: "linux", arch: "x64", packaged: true,
        dependencies: {
          fetchRelease: async () => ({
            tag_name: `v${tag}`, ...flags,
            assets: [`codex-m365-copilot-${tag}-linux-x64.AppImage`, "checksums.txt"].map(name => ({
              name,
              browser_download_url: `https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v${tag}/${name}`,
            })),
          }),
        },
      });
      const hidden = flags.prerelease || flags.draft;
      const state = await controller.checkOnce();
      if (hidden) {
        assert.equal(state.status, "up-to-date");
        await assert.rejects(controller.beginInstall(), /No launcher update/);
      } else {
        assert.equal(state.status, "available");
        assert.equal(state.version, tag);
      }
    }
  }
});

test("two-step download verifies SHA-256, emits progress, supports cancel, and supports ignore version", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-two-step-update-"));
  const settingsStore = new UpdaterSettingsStore(root);
  const assetBody = Buffer.from("verified-release-payload");
  const expectedHash = crypto.createHash("sha256").update(assetBody).digest("hex");
  const notifications = [];
  const statuses = [];
  let failChecksum = false;

  try {
    const controller = createUpdateController({
      currentVersion: "1.1.4",
      platform: "win32",
      arch: "x64",
      packaged: true,
      executablePath: "C:\\Users\\test\\AppData\\Local\\Programs\\Codex M365 Copilot.exe",
      runtimeExecutable: "C:\\bun.exe",
      logsDirectory: path.join(root, "logs"),
      updatesDirectory: path.join(root, "updates"),
      settingsStore,
      publish: (state) => statuses.push({ status: state.status, percent: state.progress?.percent ?? null }),
      onNotify: (event) => notifications.push(event),
      dependencies: {
        fetchRelease: async () => ({
          tag_name: "v1.2.0",
          body: "Release notes",
          assets: [
            {
              name: "codex-m365-copilot-1.2.0-win-x64.exe",
              size: assetBody.length,
              browser_download_url: "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/codex-m365-copilot-1.2.0-win-x64.exe",
            },
            {
              name: "checksums.txt",
              browser_download_url: "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/checksums.txt",
            },
          ],
        }),
        downloadText: async () => `${failChecksum ? "0".repeat(64) : expectedHash}  codex-m365-copilot-1.2.0-win-x64.exe\n`,
        downloadFile: async (_url, destination, options = {}) => {
          options.onProgress?.({ percent: 50, bytesDownloaded: 12, totalBytes: assetBody.length, speedBytesPerSec: 1200 });
          fs.writeFileSync(destination, assetBody);
          return { sha256: expectedHash, bytesDownloaded: assetBody.length, totalBytes: assetBody.length };
        },
        sha256: (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
      },
    });

    await controller.checkForUpdates({ manual: true });
    assert.equal(controller.getState().status, "available");

    // 1. Test ignore version skips auto-check, but manual check shows it again.
    const ignoredState = controller.ignoreCurrentUpdate();
    assert.equal(ignoredState.status, "up-to-date");
    assert.equal(settingsStore.getSettings().ignoredVersion, "1.2.0");
    assert.equal((await controller.checkForUpdates({ manual: false })).status, "up-to-date");
    assert.equal((await controller.checkForUpdates({ manual: true })).status, "available");

    // 2. Test SHA-256 mismatch cleans up partial file and enters error state.
    failChecksum = true;
    const failedDownload = await controller.downloadUpdate();
    assert.equal(failedDownload.status, "error");
    assert.match(failedDownload.message, /SHA-256 verification failed/);
    assert.equal(fs.existsSync(path.join(root, "updates", "1.2.0", "codex-m365-copilot-1.2.0-win-x64.exe")), false);

    // 3. Test successful download transitions to downloaded with verifiedSha256 and notifies.
    failChecksum = false;
    const done = await controller.downloadUpdate();
    assert.equal(done.status, "downloaded");
    assert.equal(done.verifiedSha256, expectedHash);
    assert.equal(fs.existsSync(done.downloadedFilePath), true);
    assert.ok(statuses.some((entry) => entry.status === "downloading" && entry.percent === 50));
    assert.ok(notifications.some((entry) => entry.kind === "downloaded" && entry.version === "1.2.0"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("download cancellation aborts active transfer and reverts state to available", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-cancel-download-"));
  try {
    let releaseDownload;
    const controller = createUpdateController({
      currentVersion: "1.1.4",
      platform: "win32",
      arch: "x64",
      packaged: true,
      updatesDirectory: path.join(root, "updates"),
      dependencies: {
        fetchRelease: async () => ({
          tag_name: "v1.2.0",
          assets: [
            {
              name: "codex-m365-copilot-1.2.0-win-x64.exe",
              browser_download_url: "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/codex-m365-copilot-1.2.0-win-x64.exe",
            },
            {
              name: "checksums.txt",
              browser_download_url: "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/checksums.txt",
            },
          ],
        }),
        downloadText: async () => `${"b".repeat(64)}  codex-m365-copilot-1.2.0-win-x64.exe\n`,
        downloadFile: (_url, _dest, { signal }) => new Promise((resolve, reject) => {
          releaseDownload = resolve;
          signal.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        }),
      },
    });
    await controller.checkOnce();
    const downloading = controller.downloadUpdate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(controller.getState().status, "downloading");
    assert.deepEqual(controller.cancelDownload(), { cancelled: true });
    const reverted = await downloading;
    assert.equal(reverted.status, "available");
    releaseDownload?.();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS falls back to opening the verified package when current app cannot be overwritten", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-mac-fallback-"));
  const opened = [];
  const assetBody = Buffer.from("mac-zip-bytes");
  const hash = crypto.createHash("sha256").update(assetBody).digest("hex");
  try {
    const controller = createUpdateController({
      currentVersion: "1.1.4",
      platform: "darwin",
      arch: "arm64",
      packaged: true,
      executablePath: "/private/var/folders/AppTranslocation/xyz/Codex M365 Copilot.app/Contents/MacOS/Codex M365 Copilot",
      updatesDirectory: path.join(root, "updates"),
      shell: {
        openPath: async (filePath) => { opened.push(filePath); return ""; },
      },
      dependencies: {
        fetchRelease: async () => ({
          tag_name: "v1.2.0",
          assets: [
            {
              name: "codex-m365-copilot-1.2.0-mac-arm64.zip",
              browser_download_url: "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/codex-m365-copilot-1.2.0-mac-arm64.zip",
            },
            {
              name: "checksums.txt",
              browser_download_url: "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/checksums.txt",
            },
          ],
        }),
        downloadText: async () => `${hash}  codex-m365-copilot-1.2.0-mac-arm64.zip\n`,
        downloadFile: async (_url, dest) => fs.writeFileSync(dest, assetBody),
        sha256: (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
      },
    });
    await controller.checkOnce();
    await controller.downloadUpdate();
    const res = await controller.beginInstall();
    assert.equal(res.installed, false);
    assert.equal(res.mode, "mac-opened-file");
    assert.equal(opened.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const arch of ["x64", "arm64"]) {
  test(`verified Linux ${arch} update is handed to one detached worker`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-update-test-"));
    const oldAppImage = path.join(root, "versions", "1.1.4", "Codex Web GPT.AppImage");
    const wrapper = path.join(root, "bin", "codex-web-gpt");
    fs.mkdirSync(path.dirname(oldAppImage), { recursive: true });
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(oldAppImage, "old");
    fs.writeFileSync(wrapper, "old wrapper");
    const assetBody = Buffer.from("new appimage");
    const hash = crypto.createHash("sha256").update(assetBody).digest("hex");
    let spawned = null;
    const previousAppImage = process.env.CODEX_WEB_GPT_APPIMAGE;
    const previousWrapper = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
    process.env.CODEX_WEB_GPT_APPIMAGE = oldAppImage;
    process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = wrapper;
    try {
      const controller = createUpdateController({
        currentVersion: "1.1.4",
        platform: "linux",
        arch,
        packaged: true,
        executablePath: "/tmp/launcher",
        runtimeExecutable: "/durable/bun",
        logsDirectory: path.join(root, "logs"),
        updatesDirectory: path.join(root, "updates"),
        dependencies: {
          fetchRelease: async () => ({
            tag_name: "v1.2.0",
            assets: [
              {
                name: `codex-m365-copilot-1.2.0-linux-${arch}.AppImage`,
                browser_download_url: `https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/codex-m365-copilot-1.2.0-linux-${arch}.AppImage`,
              },
              {
                name: "checksums.txt",
                browser_download_url: "https://github.com/huytvdev22/codex-chatgpt-web/releases/download/v1.2.0/checksums.txt",
              },
            ],
          }),
          downloadText: async () => `${hash}  codex-m365-copilot-1.2.0-linux-${arch}.AppImage\n`,
          downloadFile: async (_url, destination) => fs.writeFileSync(destination, assetBody),
          sha256: (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
          spawnWorker: (runtime, worker, job) => {
            spawned = { runtime, worker, job, data: JSON.parse(fs.readFileSync(job, "utf8")) };
            return { pid: 123, unref() {}, kill() {} };
          },
        },
      });
      await controller.checkOnce();
      const launch = await controller.beginInstall();
      assert.equal(spawned.runtime, "/durable/bun");
      assert.equal(spawned.data.version, "1.2.0");
      assert.equal(spawned.data.target, oldAppImage);
      assert.equal(spawned.data.wrapper, wrapper);
      assert.equal(path.basename(spawned.data.runnerSource), "linux-appimage-runner.sh");
      assert.equal(fs.existsSync(spawned.data.runnerSource), true);
      assert.equal(controller.getState().status, "installing");
      controller.cancelInstall(launch);
      assert.equal(fs.existsSync(launch.tempRoot), false);
      assert.equal(controller.getState().status, "downloaded");
      assert.equal(controller.getState().version, "1.2.0");
    } finally {
      if (previousAppImage === undefined) delete process.env.CODEX_WEB_GPT_APPIMAGE;
      else process.env.CODEX_WEB_GPT_APPIMAGE = previousAppImage;
      if (previousWrapper === undefined) delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
      else process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = previousWrapper;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("detached worker replaces an installed Linux AppImage and removes the old version", {
  skip: process.platform === "win32" ? "Linux AppImage execution is not meaningful on Windows" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-worker-test-"));
  const jobRoot = path.join(root, "job");
  const versionsRoot = path.join(root, "versions");
  const oldTarget = path.join(versionsRoot, "1.1.4", "Codex Web GPT.AppImage");
  const newTarget = path.join(versionsRoot, "1.2.0", "Codex Web GPT.AppImage");
  const wrapper = path.join(root, "bin", "codex-web-gpt");
  const marker = path.join(root, "launched");
  const source = path.join(jobRoot, "update.AppImage");
  const runnerSource = path.join(jobRoot, "run-appimage");
  const logPath = path.join(root, "logs", "update-worker.log");
  fs.mkdirSync(path.dirname(oldTarget), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.writeFileSync(oldTarget, "old");
  fs.writeFileSync(wrapper, "old wrapper");
  fs.writeFileSync(source, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  fs.writeFileSync(runnerSource, "#!/bin/sh\ntarget=\"$1\"\nshift\nexec \"$target\" \"$@\"\n", { mode: 0o755 });
  const jobPath = path.join(jobRoot, "job.json");
  fs.writeFileSync(jobPath, JSON.stringify({
    version: "1.2.0",
    platform: "linux",
    parentPid: 2_147_483_647,
    tempRoot: jobRoot,
    logPath,
    source,
    target: oldTarget,
    wrapper,
    runnerSource,
  }));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "electron", "app", "update-worker.cjs"), jobPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(newTarget), true);
    assert.equal(fs.existsSync(path.dirname(oldTarget)), false);
    assert.match(fs.readFileSync(wrapper, "utf8"), /versions\/1\.2\.0\/Codex Web GPT\.AppImage/);
    assert.doesNotMatch(fs.readFileSync(wrapper, "utf8"), /APPIMAGE_EXTRACT_AND_RUN/);
    assert.equal(fs.existsSync(path.join(versionsRoot, "run-appimage")), true);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    assert.equal(fs.readFileSync(marker, "utf8"), "launched");
    assert.match(fs.readFileSync(logPath, "utf8"), /installed and relaunched/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detached worker launches Windows installer GUI without silent /S flag", () => {
  const workerSource = fs.readFileSync(path.join(__dirname, "..", "electron", "app", "update-worker.cjs"), "utf8");
  const fnSlice = workerSource.slice(
    workerSource.indexOf("function updateWindows("),
    workerSource.indexOf("function shellQuote("),
  );
  assert.doesNotMatch(fnSlice, /"\/S"|'\/S'/);
  assert.match(fnSlice, /windowsHide:\s*false/);
  assert.match(fnSlice, /launch\(job\.source,\s*\[\],\s*\{\s*windowsHide:\s*false\s*\}\)/);
});
