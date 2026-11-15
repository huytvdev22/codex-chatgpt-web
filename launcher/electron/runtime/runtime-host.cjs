const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const {
  connectorNameForDevSetup,
  connectorNameForSetup,
  CURRENT_CONNECTOR_NAME,
  DEV_CONNECTOR_NAME,
  isLegacyConnectorName,
  validateConnectorName,
  validateConnectorNameSuffix,
} = require("../infra/connector-identity.cjs");
const { embeddedRuntimeInvocation, runtimeInvocation } = require("./runtime-command.cjs");
const { redactText } = require("../infra/logging.cjs");
const { DETACH_OWNED_CHILD, terminateOwnedProcessTree } = require("./process-tree.cjs");
const { windowsTrustEnvironment } = require("../infra/windows-trust.cjs");
const { SetupTransaction } = require("./setup-transaction.cjs");

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_LOG_LINE_CHARS = 10 * 1024 * 1024;
const CORE_SETUP_TIMEOUT_MS = 5 * 60_000;
const UNINSTALL_TIMEOUT_MS = 2 * 60_000;
function collect(stream, chunks, onLine, onError) {
  let buffered = "";
  let bytes = 0;
  stream.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_CAPTURE_BYTES) chunks.push(chunk);
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      if (line) onLine(line);
    }
    if (buffered.length > MAX_RUNTIME_LOG_LINE_CHARS) {
      onLine(`${buffered.slice(0, MAX_RUNTIME_LOG_LINE_CHARS)}â€¦[truncated]`);
      buffered = "";
    }
  });
  stream.on("end", () => {
    const line = buffered.trim();
    if (line) onLine(line);
  });
  stream.on("error", (error) => onError?.(error));
}

function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function usableExecutable(candidate, platform = process.platform) {
  if (typeof candidate !== "string" || !candidate) return false;
  const absolute = platform === "win32" ? path.win32.isAbsolute(candidate) : path.posix.isAbsolute(candidate);
  if (!absolute) return false;
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseBridgeRouteResult(stdout, { expectedActive, requireInstalled = false } = {}) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("Codex bridge route command returned invalid JSON");
  }
  if (typeof result?.active !== "boolean") {
    throw new Error("Codex bridge route command did not report its active state");
  }
  if (requireInstalled && typeof result.installed !== "boolean") {
    throw new Error("Codex bridge route status did not report whether the integration is installed");
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(`Codex bridge route is inconsistent: ${result.errors.join("; ")}`);
  }
  if (typeof expectedActive === "boolean" && result.active !== expectedActive) {
    throw new Error(`Codex bridge route remained ${result.active ? "connected" : "disconnected"}`);
  }
  return result;
}

class RuntimeHost {
  constructor({
    app,
    logger,
    sourceRoot,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath,
    coreHome,
    codexHome,
    launcherProfile = "production",
    launchAgentsDir,
    platform = process.platform,
    publishOperation,
    supervisor,
  }) {
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.installedRuntimeRoot = installedRuntimeRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.browserDescriptorPath = browserDescriptorPath;
    if (launcherProfile !== "production" && launcherProfile !== "development") {
      throw new Error("Runtime host launcher profile is invalid");
    }
    this.launcherProfile = launcherProfile;
    this.coreHome = coreHome ? resolveUserPath(coreHome) : null;
    if (launcherProfile === "development" && !this.coreHome) {
      throw new Error("Runtime host DEV profile requires its isolated home");
    }
    this.platform = platform;
    this.codexHome = codexHome
      ? resolveUserPath(codexHome)
      : process.env.CODEX_HOME?.trim()
        ? resolveUserPath(process.env.CODEX_HOME.trim())
        : path.join(os.homedir(), ".codex");
    this.launchAgentsDir = launchAgentsDir
      ? resolveUserPath(launchAgentsDir)
      : path.join(os.homedir(), "Library", "LaunchAgents");
    this.publishOperation = publishOperation;
    this.supervisor = supervisor;
    this.active = null;
    this.activeChild = null;
    this.lifecycleOperation = null;
    this.setupTransaction = new SetupTransaction(this);
    this.cleanupEphemeralSecrets();
  }

  currentOperation() {
    const stuckChild = this.activeChild
      && this.activeChild.exitCode === null
      && this.activeChild.signalCode === null;
    return this.lifecycleOperation || this.active || (stuckChild ? "previous runtime process shutdown" : null);
  }

  assertProductionProfile(operation) {
    if (this.launcherProfile !== "production") {
      throw new Error(`${operation} is unavailable in the isolated DEV launcher profile`);
    }
  }

  cleanupEphemeralSecrets() {
    const secretsDir = path.join(this.app.getPath("userData"), "secrets");
    try {
      for (const entry of fs.readdirSync(secretsDir, { withFileTypes: true })) {
        if (/^runtime-key-(?:\d+|[a-f0-9]{32})\.tmp$/.test(entry.name)) {
          fs.rmSync(path.join(secretsDir, entry.name), { force: true });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.warn("runtime.secret_cleanup_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  command(args) {
    if (this.runtimeRootProvider) this.installedRuntimeRoot = this.runtimeRootProvider();
    return runtimeInvocation({
      app: this.app,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.installedRuntimeRoot,
      args,
    });
  }

  launcherControlEnvironment() {
    let descriptor;
    try {
      descriptor = JSON.parse(fs.readFileSync(this.browserDescriptorPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Launcher browser ownership descriptor is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const token = descriptor?.control?.token;
    if (descriptor?.pid !== process.pid || typeof token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(token)) {
      throw new Error("Launcher browser ownership descriptor does not belong to this launcher process");
    }
    return { CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: token };
  }

  devSetupEnvironment(environment = process.env) {
    if (this.launcherProfile !== "development" || !this.coreHome) {
      throw new Error("DEV setup environment requires the isolated DEV launcher");
    }
    const childEnvironment = { ...environment };
    delete childEnvironment.CODEX_CHATGPT_WEB_HOME;
    delete childEnvironment.CODEX_HOME;
    delete childEnvironment.CODEX_WEB_GPT_LAUNCHER_DATA_DIR;
    childEnvironment.CODEX_WEB_GPT_DEV_HOME = this.coreHome;
    return childEnvironment;
  }

  runtimeConfigSnapshot() {
    const setupConfig = this.supervisor.readSetupConfig
      ? this.supervisor.readSetupConfig()
      : this.supervisor.readConfig();
    if (!setupConfig) {
      return {
        configured: false,
        owner: "none",
        mode: "browser-only",
        serialized: null,
      };
    }
    const launcherOwned = setupConfig.browserHost === "launcher";
    const config = launcherOwned ? this.supervisor.readConfig() : setupConfig;
    return {
      configured: true,
      owner: launcherOwned ? "launcher" : "external",
      mode: "browser-only",
      serialized: JSON.stringify(config),
      config: structuredClone(config),
    };
  }

  captureSetupCheckpoint(snapshot) {
    return this.setupTransaction.capture(snapshot);
  }

  setupCheckpointChanged(checkpoint) {
    return this.setupTransaction.hasChanged(checkpoint);
  }

  restoreSetupCheckpoint(checkpoint) {
    return this.setupTransaction.restore(checkpoint);
  }

  async restorePreviousRuntime(snapshot, operationName, options) {
    return this.setupTransaction.restorePreviousRuntime(snapshot, operationName, options);
  }

  async rollbackFirstSetup(checkpoint) {
    return this.setupTransaction.rollbackFirstSetup(checkpoint);
  }

  async run(name, args, options = {}) {
    if (this.active) throw new Error(`Another launcher operation is active: ${this.active}`);
    if (this.activeChild
      && this.activeChild.exitCode === null
      && this.activeChild.signalCode === null) {
      throw new Error("A previous launcher operation process is still running");
    }
    this.activeChild = null;
    if (this.lifecycleOperation && this.lifecycleOperation !== name) {
      throw new Error(`Another launcher operation is active: ${this.lifecycleOperation}`);
    }
    this.active = name;
    this.publishOperation?.({ name, status: "running", message: options.message || name });
    this.logger.info("runtime.operation_started", { name, args: args.map((arg) => /key|token/i.test(arg) ? "[redacted]" : arg) });
    try {
      const invocation = options.embedded
        ? embeddedRuntimeInvocation({ app: this.app, sourceRoot: this.sourceRoot, args })
        : this.command(args);
      const result = await new Promise((resolve, reject) => {
        const environment = windowsTrustEnvironment({
          ...(options.environment ?? process.env),
          CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
          ...(options.env || {}),
        }, this.platform);
        const child = spawn(invocation.executable, invocation.args, {
          cwd: invocation.cwd,
          detached: DETACH_OWNED_CHILD,
          env: environment,
          stdio: [options.controlStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        this.activeChild = child;
        const stdout = [];
        const stderr = [];
        const pipeErrors = [];
        const recordPipeError = (stream) => (error) => {
          pipeErrors.push(`${name} ${stream} pipe failed: ${error instanceof Error ? error.message : String(error)}`);
        };
        collect(child.stdout, stdout, (line) => {
          this.logger.info("runtime.stdout", { operation: name, line });
          this.publishOperation?.({ name, status: "running", message: redactText(line) });
        }, recordPipeError("stdout"));
        collect(child.stderr, stderr, (line) => {
          this.logger.warn("runtime.stderr", { operation: name, line });
          this.publishOperation?.({ name, status: "running", message: redactText(line) });
        }, recordPipeError("stderr"));
        let settled = false;
        let timedOut = null;
        let terminationTimeout = null;
        let forceTimeout = null;
        const clearTimers = () => {
          if (timeout) clearTimeout(timeout);
          if (terminationTimeout) clearTimeout(terminationTimeout);
          if (forceTimeout) clearTimeout(forceTimeout);
        };
        const timeout = options.timeoutMs
          ? setTimeout(() => {
              if (settled) return;
              timedOut = new Error(`${name} timed out after ${options.timeoutMs}ms`);
              try {
                terminateOwnedProcessTree(child);
              } catch (error) {
                settled = true;
                clearTimers();
                reject(new Error(
                  `${timedOut.message}; child process tree termination failed: ${error instanceof Error ? error.message : String(error)}`,
                ));
                return;
              }
              terminationTimeout = setTimeout(() => {
                if (settled) return;
                try {
                  terminateOwnedProcessTree(child, "SIGKILL");
                } catch (error) {
                  settled = true;
                  clearTimers();
                  reject(new Error(
                    `${timedOut.message}; forced child process tree termination failed: ${error instanceof Error ? error.message : String(error)}`,
                  ));
                  return;
                }
                forceTimeout = setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  clearTimers();
                  reject(new Error(`${timedOut.message}; the child process did not exit after forced termination`));
                }, 2_000);
              }, 5_000);
            }, options.timeoutMs)
          : null;
        child.once("error", (error) => {
          const childStillRunning = Number.isInteger(child.pid)
            && child.exitCode === null
            && child.signalCode === null;
          if (this.activeChild === child && !childStillRunning) this.activeChild = null;
          if (settled) return;
          settled = true;
          clearTimers();
          reject(timedOut
            ? new Error(`${timedOut.message}; termination failed: ${error.message}`)
            : error);
        });
        child.once("exit", (code, signal) => {
          if (this.activeChild === child) this.activeChild = null;
          if (settled) return;
          settled = true;
          clearTimers();
          if (timedOut) {
            try {
              terminateOwnedProcessTree(child, "SIGKILL");
              reject(timedOut);
            } catch (error) {
              reject(new Error(
                `${timedOut.message}; final process-group cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              ));
            }
            return;
          }
          if (pipeErrors.length > 0) {
            reject(new Error(pipeErrors.join("; ")));
            return;
          }
          resolve({
            code: code ?? 1,
            signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
      const acceptedExitCodes = options.acceptedExitCodes || [0];
      if (!acceptedExitCodes.includes(result.code)) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        throw new Error(detail);
      }
      this.logger.info("runtime.operation_completed", { name });
      this.publishOperation?.({ name, status: "completed", message: options.successMessage || "Completed" });
      return result;
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      this.logger.error("runtime.operation_failed", { name, message });
      this.publishOperation?.({ name, status: "failed", message });
      throw new Error(message);
    } finally {
      this.active = null;
    }
  }

  async doctor() {
    this.assertProductionProfile("Runtime doctor");
    try {
      const result = await this.run("doctor", ["doctor", "--json"], {
        message: "Checking runtime",
        timeoutMs: 75_000,
        acceptedExitCodes: [0, 1],
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      return {
        ok: false,
        checks: [{ id: "runtime", status: "error", message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  async devDoctor() {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV harness diagnostics require the isolated DEV launcher profile");
    }
    const checks = [];
    let config;
    try {
      config = this.supervisor.readConfig();
      checks.push({
        id: "dev-profile",
        status: config?.purpose === "dev-harness" ? "ok" : "error",
        message: config?.purpose === "dev-harness"
          ? "Isolated DEV harness configuration is valid"
          : "Isolated DEV harness configuration is missing",
      });
    } catch (error) {
      checks.push({
        id: "dev-profile",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    checks.push({
      id: "browser-runtime",
      status: "ok",
      message: "DEV profile uses the isolated browser-backed runtime without an MCP tunnel",
    });
    return {
      ok: checks.every(check => check.status !== "error"),
      mode: config?.mode,
      checks,
    };
  }

  async bridgeStatus(operationName = "bridge-status") {
    this.assertProductionProfile("Codex bridge status");
    const result = await this.run(operationName, ["route", "status"], {
      embedded: true,
      message: "Checking Codex bridge route",
      successMessage: "Codex bridge route checked",
      timeoutMs: 15_000,
    });
    return parseBridgeRouteResult(result.stdout, { requireInstalled: true });
  }

  async restoreBridgeRouteWithinOperation(operationName) {
    const current = await this.bridgeStatus(operationName);
    if (!current.installed || !current.active) return current;
    const disconnected = await this.run(operationName, ["route", "disconnect"], {
      embedded: true,
      message: "Restoring the previous Codex route",
      successMessage: "Previous Codex route restored",
      timeoutMs: 15_000,
    });
    const result = parseBridgeRouteResult(disconnected.stdout, { expectedActive: false });
    const verified = await this.bridgeStatus(operationName);
    if (!verified.installed || verified.active) {
      throw new Error("Codex bridge route restore did not persist in the active config");
    }
    return {
      ...result,
      installed: true,
    };
  }

  async restoreBridgeRoute(operationName = "bridge-route-restore") {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = operationName;
    try {
      return await this.restoreBridgeRouteWithinOperation(operationName);
    } finally {
      this.lifecycleOperation = null;
    }
  }

  async connectBridgeRoute() {
    this.assertProductionProfile("Codex bridge routing");
    const name = "bridge-connect";
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = name;
    try {
      const current = await this.bridgeStatus(name);
      if (!current.installed) throw new Error("Install the Codex integration before connecting the bridge route");
      if (current.active) return current;
      try {
        const connected = await this.run(name, ["route", "connect"], {
          embedded: true,
          message: "Connecting Codex to the launcher",
          successMessage: "Codex bridge connected",
          timeoutMs: 15_000,
        });
        const result = parseBridgeRouteResult(connected.stdout, { expectedActive: true });
        const verified = await this.bridgeStatus(name);
        if (!verified.installed || !verified.active) {
          throw new Error("Codex bridge route connection did not persist in the active config");
        }
        return result;
      } catch (error) {
        let cleanupError;
        try { await this.supervisor.stopForSetup(); } catch (caught) { cleanupError = caught; }
        if (!cleanupError) throw error;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; stopping the unrouted runtime also failed:`
          + ` ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    } finally {
      this.lifecycleOperation = null;
    }
  }

  browserConnectorName() {
    const current = this.runtimeConfigSnapshot();
    if (this.launcherProfile === "development") {
      return connectorNameForDevSetup(current.config?.appName);
    }
    if (!current.configured) return CURRENT_CONNECTOR_NAME;
    return connectorNameForSetup(current.config?.appName);
  }

  setupConnectorName() {
    const current = this.runtimeConfigSnapshot().config;
    const defaultName = this.launcherProfile === "development" ? DEV_CONNECTOR_NAME : CURRENT_CONNECTOR_NAME;
    const stored = current?.appName;
    if (stored !== undefined) {
      if (isLegacyConnectorName(stored) || stored === "Codex Zero Risk") return defaultName;
      return this.launcherProfile === "development"
        ? connectorNameForDevSetup(stored)
        : connectorNameForSetup(stored);
    }
    return defaultName;
  }

  async setConnectorNameSuffix(value) {
    const suffix = validateConnectorNameSuffix(value);
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) throw new Error("Set up the launcher before changing the plugin name");
    const name = `Codex ${suffix}`;
    if (name === this.setupConnectorName()) return { changed: false };
    const args = [
      ...(this.launcherProfile === "development" ? ["dev", "setup"] : ["setup"]),
      "--browser-only",
      "--browser-host-descriptor", this.browserDescriptorPath,
      "--connector-name-suffix", suffix,
      "--acknowledge-unofficial",
      ...(this.launcherProfile === "production" ? ["--replace-codex-route", "--restart-service"] : []),
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const options = {
      message: "Changing the plugin name",
      successMessage: "Plugin name changed",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    };
    if (this.launcherProfile === "development") await this.runDevSetup("connector-name", args, options);
    else await this.runSetup("connector-name", args, options);
    return { changed: true };
  }

  cancelActiveTurns() {
    this.assertProductionProfile("Launcher-owned turn cancellation");
    return this.run("cancel-active-turns", ["service", "cancel-turns"], {
      message: "Cancelling active Codex turns",
      successMessage: "Active Codex turns cancelled",
      timeoutMs: 15_000,
    });
  }

  async uninstallIntegration() {
    this.assertProductionProfile("Codex integration removal");
    const name = "uninstall-integration";
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const previousRuntime = this.runtimeConfigSnapshot();
    this.lifecycleOperation = name;
    try {
      try {
        if (previousRuntime.owner === "external") this.supervisor.prepareExternalMigration();
        else await this.supervisor.stopForSetup();
      } catch (error) {
        try {
          await this.restoreBridgeRouteWithinOperation(name);
        } catch (routeError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; restoring the previous Codex route also failed:`
            + ` ${routeError instanceof Error ? routeError.message : String(routeError)}`,
          );
        }
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; the previous Codex route was restored,`
          + " but launcher runtime cleanup did not complete",
        );
      }
      try {
        const result = await this.run(name, ["uninstall", "--yes", "--launcher-control"], {
          embedded: true,
          env: this.launcherControlEnvironment(),
          message: "Restoring the previous Codex route",
          successMessage: "Codex Web GPT integration removed",
          timeoutMs: UNINSTALL_TIMEOUT_MS,
        });
        const verified = await this.bridgeStatus(name);
        if (verified.installed || verified.active) {
          throw new Error("Codex integration removal did not persist in the active config");
        }
        return result;
      } catch (error) {
        try {
          await this.restoreBridgeRouteWithinOperation(name);
        } catch (routeError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; restoring the previous Codex route also failed:`
            + ` ${routeError instanceof Error ? routeError.message : String(routeError)}`,
          );
        }
        throw error;
      }
    } finally {
      this.lifecycleOperation = null;
    }
  }

  async setupCore() {
    this.assertProductionProfile("Codex integration setup");
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const mode = existing.mode;
    const args = [
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
    ];
    const result = await this.runSetup("core-setup", args, {
      message: "Installing ChatGPT Web models into Codex",
      successMessage: "Codex integration installed",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode };
  }

  async setupDevCore() {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV profile setup requires the isolated DEV launcher");
    }
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const mode = existing.mode;
    const args = [
      "dev",
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      "--acknowledge-unofficial",
    ];
    const result = await this.runDevSetup("dev-profile-setup", args, {
      message: "Configuring the isolated DEV harness",
      successMessage: "Isolated DEV harness configured",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode };
  }

  async setBiggerContext(enabled) {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) {
      throw new Error("Initialize the runtime before changing Bigger Context");
    }
    const mode = current.mode;
    const contextFlag = enabled === true ? "--bigger-context" : "--standard-context";
    if (this.launcherProfile === "development") {
      const args = [
        "dev",
        "setup",
        "--browser-only",
        "--browser-host-descriptor",
        this.browserDescriptorPath,
        "--acknowledge-unofficial",
        contextFlag,
      ];
      if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
      const result = await this.runDevSetup("bigger-context", args, {
        message: enabled ? "Enabling Bigger Context" : "Disabling Bigger Context",
        successMessage: enabled ? "Bigger Context enabled" : "Standard context restored",
        timeoutMs: CORE_SETUP_TIMEOUT_MS,
      });
      return { ...result, mode, enabled: enabled === true };
    }
    const args = [
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
      contextFlag,
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const result = await this.runSetup("bigger-context", args, {
      message: enabled ? "Enabling Bigger Context" : "Disabling Bigger Context",
      successMessage: enabled ? "Bigger Context enabled; restart Codex" : "Standard context restored; restart Codex",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode, enabled: enabled === true };
  }

  async setSkillAttachments(enabled) {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) throw new Error("Initialize the runtime before changing Skills as files");
    const development = this.launcherProfile === "development";
    const args = [
      ...(development ? ["dev", "setup"] : ["setup"]),
      "--browser-only",
      "--browser-host-descriptor", this.browserDescriptorPath,
      "--acknowledge-unofficial",
      ...(development ? [] : ["--replace-codex-route", "--restart-service"]),
      enabled === true ? "--skill-attachments" : "--inline-skills",
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const options = {
      message: enabled ? "Enabling Skills as files" : "Disabling Skills as files",
      successMessage: enabled ? "Skills as files enabled" : "Inline skills restored",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    };
    const result = development
      ? await this.runDevSetup("skill-attachments", args, options)
      : await this.runSetup("skill-attachments", args, options);
    return { ...result, enabled: enabled === true };
  }

  async setFreshConversationPerTurn(enabled) {
    if (typeof enabled !== "boolean") throw new Error("Fresh conversation preference must be a boolean");
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) throw new Error("Initialize the runtime before changing browser conversation retention");
    const development = this.launcherProfile === "development";
    const args = [
      ...(development ? ["dev", "setup"] : ["setup"]),
      "--browser-only",
      "--browser-host-descriptor", this.browserDescriptorPath,
      "--acknowledge-unofficial",
      ...(development ? [] : ["--replace-codex-route", "--restart-service"]),
      enabled ? "--fresh-conversation" : "--retained-conversation",
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const options = {
      message: enabled ? "Enabling a new browser chat for each turn" : "Restoring browser chat retention",
      successMessage: enabled ? "New browser chats per turn enabled" : "Browser chat retention restored",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    };
    const result = development
      ? await this.runDevSetup("fresh-conversation-per-turn", args, options)
      : await this.runSetup("fresh-conversation-per-turn", args, options);
    return { ...result, enabled };
  }

  async setUseSavedChats(enabled) {
    if (typeof enabled !== "boolean") throw new Error("Saved chat preference must be a boolean");
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) throw new Error("Initialize the runtime before changing saved chats");
    const development = this.launcherProfile === "development";
    const args = [
      ...(development ? ["dev", "setup"] : ["setup"]),
      "--browser-only",
      "--browser-host-descriptor", this.browserDescriptorPath,
      "--acknowledge-unofficial",
      ...(development ? [] : ["--replace-codex-route", "--restart-service"]),
      enabled ? "--saved-chats" : "--temporary-chats",
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const options = {
      message: enabled ? "Enabling saved ChatGPT conversations" : "Restoring Temporary Chat",
      successMessage: enabled ? "Saved ChatGPT conversations enabled" : "Temporary Chat restored",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    };
    const result = development
      ? await this.runDevSetup("use-saved-chats", args, options)
      : await this.runSetup("use-saved-chats", args, options);
    return { ...result, enabled };
  }

  async upgradeManagedRuntime() {
    this.assertProductionProfile("Managed Codex runtime upgrade");
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const currentVersion = this.app.getVersion();
    const connectorMigrationRequired = isLegacyConnectorName(validateConnectorName(existing.config?.appName));
    if (existing.owner !== "launcher"
      || (existing.config?.releaseVersion === currentVersion
        && !connectorMigrationRequired)) {
      return { updated: false };
    }
    const args = [
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      "--acknowledge-unofficial",
      "--restart-service",
    ];
    const result = await this.runSetup("runtime-upgrade", args, {
      message: `Upgrading launcher runtime from ${existing.config.releaseVersion} to ${currentVersion}`,
      successMessage: `Launcher runtime upgraded to ${currentVersion}`,
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return {
      updated: true,
      mode: existing.mode,
      fromVersion: existing.config.releaseVersion,
      toVersion: currentVersion,
      connectorMigrated: connectorMigrationRequired,
      stdout: result.stdout,
    };
  }

  async runDevSetup(name, args, options) {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV setup transaction requires the isolated DEV launcher");
    }
    return this.runSetup(name, args, {
      ...options,
      embedded: true,
      environment: this.devSetupEnvironment(),
    });
  }

  async runSetup(name, args, options) {
    return this.setupTransaction.execute(name, args, options);
  }
}

module.exports = { CURRENT_CONNECTOR_NAME, RuntimeHost };
