const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("../infra/atomic-file.cjs");

const MAX_CHECKPOINT_FILE_BYTES = 16 * 1024 * 1024;
const CORE_SETUP_TIMEOUT_MS = 5 * 60_000;

function captureRegularFile(filePath, { followSymlink = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: filePath, exists: false };
    throw error;
  }
  let symlink;
  if (followSymlink && stat.isSymbolicLink()) {
    symlink = { link: fs.readlinkSync(filePath), target: fs.realpathSync(filePath) };
    stat = fs.lstatSync(symlink.target);
  }
  if (!stat.isFile()) {
    throw new Error(`Setup checkpoint path is not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) {
    throw new Error(`Setup checkpoint file exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes: ${filePath}`);
  }
  return {
    path: filePath,
    exists: true,
    data: fs.readFileSync(symlink?.target ?? filePath),
    mode: stat.mode & 0o777,
    ...(symlink ? { symlink } : {}),
  };
}

function checkpointWritePath(snapshot) {
  if (!snapshot.symlink) return snapshot.path;
  if (!fs.lstatSync(snapshot.path).isSymbolicLink()
    || fs.readlinkSync(snapshot.path) !== snapshot.symlink.link
    || fs.realpathSync(snapshot.path) !== snapshot.symlink.target) {
    throw new Error(`Codex config symlink changed during setup: ${snapshot.path}`);
  }
  return snapshot.symlink.target;
}

function restoreRegularFile(snapshot, platform = process.platform) {
  if (!snapshot.exists) {
    fs.rmSync(snapshot.path, { force: true });
    return;
  }
  const writePath = checkpointWritePath(snapshot);
  writePrivateFileAtomic(writePath, snapshot.data, snapshot.symlink
    ? { mode: snapshot.mode, protectDirectory: false }
    : undefined);
  if (platform !== "win32") fs.chmodSync(writePath, snapshot.mode);
}

function regularFileChanged(snapshot, platform = process.platform) {
  let filePath;
  try { filePath = checkpointWritePath(snapshot); } catch { return true; }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return snapshot.exists;
    throw error;
  }
  if (!snapshot.exists || !stat.isFile()) return true;
  if (platform !== "win32" && (stat.mode & 0o777) !== snapshot.mode) return true;
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) return true;
  return !fs.readFileSync(filePath).equals(snapshot.data);
}

class SetupTransaction {
  constructor(host) {
    this.host = host;
  }

  capture(snapshot) {
    const supervisor = this.host.supervisor;
    if (typeof supervisor.configPath !== "string" || !path.isAbsolute(supervisor.configPath)) {
      throw new Error("Launcher runtime supervisor has no absolute configuration path for setup rollback");
    }
    const coreHome = supervisor.coreHome || path.dirname(supervisor.configPath);
    const paths = new Set([
      supervisor.configPath,
      path.join(coreHome, "codex", "integration-journal.json"),
      path.join(coreHome, "codex", "integration-journal.recovery.json"),
      path.join(this.host.codexHome, "config.toml"),
      path.join(this.host.codexHome, "models_cache.json"),
    ]);
    if (snapshot.owner === "external" && this.host.platform === "darwin") {
      paths.add(path.join(this.host.launchAgentsDir, "io.github.codex-chatgpt-web.daemon.plist"));
    }
    return [...paths].map(filePath => captureRegularFile(filePath, {
      followSymlink: filePath === path.join(this.host.codexHome, "config.toml"),
    }));
  }

  hasChanged(checkpoint) {
    return checkpoint ? checkpoint.some(snapshot => regularFileChanged(snapshot, this.host.platform)) : false;
  }

  restore(checkpoint) {
    if (!checkpoint) return;
    const failures = [];
    for (const snapshot of [...checkpoint].reverse()) {
      try {
        restoreRegularFile(snapshot, this.host.platform);
      } catch (error) {
        failures.push(`${snapshot.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Setup checkpoint restoration failed: ${failures.join("; ")}`);
    }
  }

  async restorePreviousRuntime(snapshot, operationName, { repairExternal = false } = {}) {
    const current = this.host.runtimeConfigSnapshot();
    if (current.owner !== snapshot.owner || current.serialized !== snapshot.serialized) {
      throw new Error(
        "Runtime configuration changed before the operation failed; refusing to describe the current runtime as the previous installation",
      );
    }
    if (snapshot.owner === "external") {
      if (repairExternal) {
        if (this.host.platform !== "darwin") {
          throw new Error("Terminal-managed runtime repair is supported only on macOS");
        }
        await this.host.run(operationName, ["service", "install"], {
          embedded: true,
          message: "Restoring the previous terminal-managed daemon",
          successMessage: "Previous terminal-managed daemon restored",
          timeoutMs: 75_000,
        });
      }
      await this.host.run(operationName, ["doctor", "--json"], {
        message: "Verifying the previous terminal-managed runtime",
        successMessage: "Previous terminal-managed runtime is still healthy",
        timeoutMs: 75_000,
      });
      return;
    }
    const runtime = await this.host.supervisor.startIfConfigured();
    const expected = snapshot.configured ? "ready" : "not-configured";
    if (runtime.status !== expected) {
      throw new Error(
        `Previous runtime recovery returned ${runtime.status}; expected ${expected}${runtime.detail ? `: ${runtime.detail}` : ""}`,
      );
    }
  }

  async rollbackFirstSetup(checkpoint) {
    const changed = this.host.setupCheckpointChanged(checkpoint);
    let stopError;
    try {
      await this.host.supervisor.stopForSetup();
    } catch (error) {
      stopError = error;
    }
    let restoreError;
    try {
      this.host.restoreSetupCheckpoint(checkpoint);
    } catch (error) {
      restoreError = error;
    }
    this.host.supervisor.clearState();
    if (stopError || restoreError) {
      const failures = [
        stopError ? `stopping the incomplete runtime failed: ${stopError instanceof Error ? stopError.message : String(stopError)}` : null,
        restoreError ? (restoreError instanceof Error ? restoreError.message : String(restoreError)) : null,
      ].filter(Boolean);
      throw new Error(failures.join("; "));
    }
    return changed;
  }

  async execute(name, args, options) {
    if (this.host.currentOperation()) {
      throw new Error(`Another launcher operation is active: ${this.host.currentOperation()}`);
    }
    const previousRuntime = this.host.runtimeConfigSnapshot();
    const checkpoint = this.host.captureSetupCheckpoint(previousRuntime);
    this.host.lifecycleOperation = name;
    let setupCommandStarted = false;
    let runtimeTransitionStarted = false;
    try {
      if (this.host.launcherProfile === "production") {
        await this.host.run(name, [...args, "--preflight-only"], {
          ...options,
          message: "Validating Codex configuration before changing the runtime",
          successMessage: "Codex configuration is ready for setup",
          timeoutMs: options.timeoutMs || CORE_SETUP_TIMEOUT_MS,
        });
      }
      runtimeTransitionStarted = true;
      if (previousRuntime.owner === "external") this.host.supervisor.prepareExternalMigration();
      else await this.host.supervisor.stopForSetup();
      setupCommandStarted = true;
      const result = await this.host.run(name, args, options);
      const runtime = await this.host.supervisor.startIfConfigured();
      if (runtime.status !== "ready") {
        throw new Error(`Setup completed, but the launcher-owned runtime is ${runtime.status}: ${runtime.detail || "not ready"}`);
      }
      await options.afterRuntimeReady?.();
      return result;
    } catch (error) {
      const primary = error instanceof Error ? error.message : String(error);
      const failures = [];
      let rolledBack = false;
      let checkpointChanged = false;
      if (!previousRuntime.configured && setupCommandStarted) {
        try {
          rolledBack = await this.host.rollbackFirstSetup(checkpoint);
        } catch (caught) {
          failures.push(
            `first-time setup rollback failed: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
      }
      if (previousRuntime.configured && checkpoint && runtimeTransitionStarted) {
        try {
          checkpointChanged = this.host.setupCheckpointChanged(checkpoint);
        } catch (caught) {
          checkpointChanged = true;
          failures.push(
            `checking the setup checkpoint failed: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
        try {
          this.host.restoreSetupCheckpoint(checkpoint);
        } catch (caught) {
          failures.push(caught instanceof Error ? caught.message : String(caught));
        }
      }
      let recoveryError;
      if (runtimeTransitionStarted) {
        try {
          await this.host.restorePreviousRuntime(previousRuntime, name, {
            repairExternal: previousRuntime.owner === "external" && checkpointChanged,
          });
        } catch (caught) {
          recoveryError = caught;
        }
      }
      if (recoveryError) {
        failures.push(
          `restoring the previous launcher runtime failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
      const message = [
        primary,
        ...(rolledBack ? ["incomplete first-time setup was rolled back"] : []),
        ...failures,
      ].join("; ");
      this.host.publishOperation?.({ name, status: "failed", message });
      throw new Error(message, { cause: error });
    } finally {
      this.host.lifecycleOperation = null;
    }
  }
}

module.exports = { SetupTransaction };

