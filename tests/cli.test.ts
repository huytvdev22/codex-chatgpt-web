import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

setDefaultTimeout(30_000);

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../src/cli.ts"),
    ...args,
  ], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("production setup rejects the removed connector-name option before configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-fixed-connector-"));
  try {
    const env = {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    };
    const result = await runCli([
      "setup", "--browser-only", "--app-name", "Other Connector", "--acknowledge-unofficial",
    ], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Unknown.*arguments: --app-name Other Connector/);
    expect(existsSync(join(root, "app", "config.json"))).toBeFalse();
    const help = await runCli(["--help"], env);
    expect(help.stdout).not.toContain("--app-name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production setup rejects conflicting conversation modes before configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-conversation-flags-"));
  try {
    const result = await runCli([
      "setup", "--browser-only", "--fresh-conversation", "--retained-conversation",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Choose --fresh-conversation or --retained-conversation");
    expect(existsSync(join(root, "app", "config.json"))).toBeFalse();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup validates the port before performing runtime work", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-"));
  try {
    const result = await runCli([
      "setup",
      "--browser-only",
      "--chrome",
      process.execPath,
      "--browser-host-descriptor",
      join(root, "launcher-browser.json"),
      "--port",
      "0",
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    const { stderr } = result;
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("--port must be an integer from 1 to 65535");
    expect(stderr).not.toContain("Choose either --chrome or --browser-host-descriptor");
    expect(stderr).not.toContain("Unknown arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal uninstall refuses to race a launcher-owned runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-uninstall-"));
  const appHome = join(root, "app");
  const configPath = join(appHome, "config.json");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: join(appHome, "runtime", "launcher-browser.json"),
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    extraHighAvailable: false, proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "launcher-uninstall-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);
  try {
    const result = await runCli([
      "uninstall",
      "--yes",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be removed from Codex Web GPT Settings");
    expect(existsSync(configPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorized launcher uninstall does not re-probe an already stopped full runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-launcher-uninstall-"));
  const appHome = join(root, "app");
  const codexHome = join(root, "codex");
  const descriptorPath = join(appHome, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  const runtimeKeyFile = join(appHome, "secrets", "runtime.key");
  const token = "launcher-uninstall-control-token-0123456789abcdef";
  mkdirSync(join(appHome, "runtime"), { recursive: true });
  mkdirSync(join(appHome, "secrets"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(helperScript, "module.exports = {};\n");
  writeFileSync(runtimeKeyFile, "test-key\n");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 3,
    kind: "codex-web-gpt-launcher",
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:48111",
    control: { endpoint: "http://127.0.0.1:48112", token },
    helper: { executable: process.execPath, script: helperScript },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32),
    surfaceTargets: { ["a".repeat(32)]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "full",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    extraHighAvailable: false, proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "runtime-control-token-0123456789abcdef0123456789",
    runtimeCommand: [process.execPath],
    tunnel: {
      binaryPath: join(root, "missing-tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile,
      profileDir: join(appHome, "tunnel", "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  })}\n`);
  try {
    const result = await runCli([
      "uninstall",
      "--yes",
      "--launcher-control",
    ], {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_CHATGPT_WEB_HOME: appHome,
      CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: descriptorPath,
      CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: token,
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Uninstalled and removed private application data");
    expect(existsSync(appHome)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
