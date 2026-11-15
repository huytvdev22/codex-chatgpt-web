import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDurableRuntimeCommand,
  CHATGPT_CONNECTOR_NAME,
  DEV_CHATGPT_CONNECTOR_NAME,
  defaultBrokerEndpoint,
  defaultConfig,
  expandUserPath,
  isWindowsPipeEndpoint,
  installedBunExecutable,
  loadConfig,
  loadConfigForSetup,
  providerConfig,
  resolveBrokerEndpoint,
  resolveConnectorIdentity,
  runtimeCommandForProcess,
  validateConnectorNameSuffix,
} from "../src/config";
import { removeLegacyRuntimeArtifacts } from "../src/service";
import { processRunning } from "../src/process";

const roots: string[] = [];
afterEach(() => {
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("managed runtime commands reject every ephemeral path component", () => {
  expect(() => assertDurableRuntimeCommand(["/private/tmp/codex-chatgpt-web"])).toThrow("ephemeral path");
  expect(() => assertDurableRuntimeCommand([process.execPath, "/tmp/build/app/cli.js"])).toThrow("ephemeral path");
  expect(() => assertDurableRuntimeCommand([process.execPath])).not.toThrow();
});

test("Windows Bun shims resolve to the installed Bun executable before service setup", () => {
  const ephemeralBun = join(tmpdir(), "bun-node-test", "bun");
  expect(runtimeCommandForProcess({
    executable: ephemeralBun,
    bunExecutable: process.execPath,
    entry: import.meta.path,
  })).toEqual([process.execPath, import.meta.path]);
  expect(() => runtimeCommandForProcess({
    executable: ephemeralBun,
    entry: import.meta.path,
  })).toThrow("ephemeral path");
});

test("installed Bun discovery ignores a temporary self-extract executable", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-bun-discovery-${process.pid}-${Date.now()}`);
  const ephemeralBun = join(root, "bun-node-test", "bun.exe");
  roots.push(root);
  mkdirSync(join(root, "bun-node-test"), { recursive: true });
  writeFileSync(ephemeralBun, "");
  expect(installedBunExecutable({
    platform: "win32",
    pathValue: "",
    candidates: [ephemeralBun, process.execPath],
  })).toBe(process.execPath);
});

test("Windows uses a stable native named pipe for the outer Codex tool broker", () => {
  const first = defaultBrokerEndpoint("C:\\Users\\alice\\.codex-chatgpt-web", "win32");
  const second = defaultBrokerEndpoint("C:\\Users\\alice\\.codex-chatgpt-web", "win32");
  expect(first).toBe(second);
  expect(isWindowsPipeEndpoint(first)).toBe(true);
  expect(resolveBrokerEndpoint(first)).toBe(first);
  expect(defaultBrokerEndpoint("/home/alice/.codex-chatgpt-web", "linux")).toEndWith(join("runtime", "turn-broker.sock"));
});

test("permission-denied process probes preserve ownership evidence", () => {
  expect(processRunning(123, () => {
    const error = new Error("access denied") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  })).toBe(true);
  expect(processRunning(123, () => {
    const error = new Error("not found") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  })).toBe(false);
  expect(processRunning(0)).toBe(false);
});

test("user-home expansion accepts native Unix and Windows separators", () => {
  expect(expandUserPath("~/runtime")).toBe(join(homedir(), "runtime"));
  expect(expandUserPath("~\\runtime")).toBe(join(homedir(), "runtime"));
});

test("default setup uses the fixed production connector identity", () => {
  expect(defaultConfig("browser-only").appName).toBe(CHATGPT_CONNECTOR_NAME);
  expect(defaultConfig("browser-only").subagentProtocol).toBe("compatibility-v1");
});

test("setup explicitly migrates v1 pro-only config to v3 managed browser-only", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-config-migration-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), `${JSON.stringify({
    version: 1,
    releaseVersion: "0.1.0",
    mode: "pro-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    chromeExecutablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    storageStatePath: join(root, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(root),
    headed: true,
    extraHighAvailable: true, proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "config-migration-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);

  expect(() => loadConfig()).toThrow("rerun setup to migrate");
  const migrated = loadConfigForSetup();
  expect(migrated).toMatchObject({
    version: 3,
    mode: "browser-only",
    browserHost: "managed-chrome",
    subagentProtocol: "compatibility-v1",
  });
  expect("solAvailable" in migrated).toBe(false);
  expect("extraHighAvailable" in migrated).toBe(false);
  expect("proAvailable" in migrated).toBe(false);
});

test("legacy temp-path wrapper and vendor are removed only after runtime ownership changes", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-legacy-runtime-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  const wrapper = join(root, "bin", "serve-with-playwright.sh");
  const vendorFile = join(root, "vendor", "node_modules", "playwright-core", "package.json");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "vendor", "node_modules", "playwright-core"), { recursive: true });
  writeFileSync(wrapper, "#!/bin/sh\n");
  writeFileSync(vendorFile, "{}\n");

  const config = defaultConfig("browser-only");
  config.runtimeCommand = [wrapper];
  expect(() => removeLegacyRuntimeArtifacts(config)).toThrow("still references");
  expect(existsSync(wrapper)).toBe(true);
  config.runtimeCommand = [process.execPath];
  removeLegacyRuntimeArtifacts(config);
  expect(existsSync(wrapper)).toBe(false);
  expect(existsSync(join(root, "vendor"))).toBe(false);
});

test("launcher browser ownership is explicit in provider configuration", () => {
  const config = defaultConfig("browser-only");
  config.browserHost = "launcher";
  config.browserHostDescriptorPath = "/Users/example/.codex-chatgpt-web/runtime/launcher-browser.json";
  config.stallTimeoutSec = 900;
  expect(providerConfig(config).chatgptWeb).toMatchObject({
    browserHost: "launcher",
    browserHostDescriptorPath: config.browserHostDescriptorPath,
    stallTimeoutSec: 900,
  });
});

test("provider configuration always exposes the unified Web configuration", () => {
  const config = defaultConfig("browser-only");
  const provider = providerConfig(config);

  expect(provider.models).toEqual(["chatgpt-web"]);
  expect(provider.defaultModel).toBe("chatgpt-web");
  expect(provider.modelReasoningEfforts).toEqual({ "chatgpt-web": ["low", "high"] });
  expect(provider.modelDefaultReasoningEfforts).toEqual({ "chatgpt-web": "low" });
  expect(provider.modelInputModalities).toEqual({ "chatgpt-web": ["text", "image"] });
  expect(provider.chatgptWeb).toMatchObject({
    experimentalBiggerContext: false,
  });
  expect("solAvailable" in (provider.chatgptWeb ?? {})).toBe(false);
  expect("extraHighAvailable" in (provider.chatgptWeb ?? {})).toBe(false);
  expect("proAvailable" in (provider.chatgptWeb ?? {})).toBe(false);
});

test("loading legacy config with capability flags strips them cleanly", () => {
  const root = join(tmpdir(), `codex-web-legacy-caps-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const raw: Record<string, unknown> = {
    ...defaultConfig("browser-only"),
    solAvailable: false,
    extraHighAvailable: true,
    proAvailable: true,
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(raw));
  const loaded = loadConfig()!;
  expect("solAvailable" in loaded).toBe(false);
  expect("extraHighAvailable" in loaded).toBe(false);
  expect("proAvailable" in loaded).toBe(false);
  const provider = providerConfig(loaded);
  expect(provider.chatgptWeb).toMatchObject({
    appName: loaded.appName,
    experimentalBiggerContext: false,
  });
});

test("conversation preferences survive reload", () => {
  const root = join(tmpdir(), `codex-web-fresh-config-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const config: Record<string, unknown> = { ...defaultConfig("browser-only") };
  const persist = () => writeFileSync(join(root, "config.json"), JSON.stringify(config));
  expect(config.experimentalFreshConversationPerTurn).toBe(false);
  expect(config.useSavedChats).toBe(false);
  delete config.useSavedChats;
  delete config.experimentalFreshConversationPerTurn;
  persist();
  expect(loadConfig()!.experimentalFreshConversationPerTurn).toBe(false);
  expect(loadConfig()!.useSavedChats).toBe(false);
  config.useSavedChats = true;
  config.experimentalFreshConversationPerTurn = true;
  persist();
  const loaded = loadConfig()!;
  expect(providerConfig(loaded).chatgptWeb!.useSavedChats).toBe(true);
  expect(providerConfig(loaded).chatgptWeb!.experimentalFreshConversationPerTurn).toBe(true);
  expect(loaded.experimentalFreshConversationPerTurn).toBe(true);
  config.experimentalFreshConversationPerTurn = "true";
  persist();
  expect(() => loadConfig()).toThrow("experimentalFreshConversationPerTurn");
  config.experimentalFreshConversationPerTurn = false;
  config.useSavedChats = "true";
  persist();
  expect(() => loadConfig()).toThrow("useSavedChats");
});

test("skill attachments config defaults off and reaches the adapter", () => {
  const root = join(tmpdir(), `codex-skills-config-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const config: Record<string, unknown> = { ...defaultConfig("browser-only") };
  config.browserHost = "launcher";
  config.browserHostDescriptorPath = join(root, "launcher.json");
  config.tunnel = { binaryPath: join(root, "tunnel"), runtimeKeyFile: join(root, "key"),
    profileDir: root, tunnelId: `tunnel_${"a".repeat(32)}`, profileName: "test", alias: "test" };
  expect(config.experimentalSkillAttachments).toBe(false);
  const persist = () => writeFileSync(join(root, "config.json"), JSON.stringify(config));
  delete config.experimentalSkillAttachments;
  persist();
  expect(loadConfig()!.experimentalSkillAttachments).toBe(false);
  config.experimentalSkillAttachments = true;
  persist();
  expect(providerConfig(loadConfig()!).chatgptWeb!.experimentalSkillAttachments).toBe(true);
  config.experimentalSkillAttachments = "true";
  persist();
  expect(() => loadConfig()).toThrow("experimentalSkillAttachments");
});

test("the whole name after Codex is editable", () => {
  for (const suffix of ["Native2", "Work", "DEV", "研究_2", "a".repeat(74)]) {
    expect(validateConnectorNameSuffix(suffix)).toBe(suffix);
    const name = resolveConnectorIdentity("production", undefined, suffix);
    expect(name).toBe(`Codex ${suffix}`);
    expect(name.length).toBeLessThanOrEqual(80);
  }
  expect(resolveConnectorIdentity("development")).toBe(DEV_CHATGPT_CONNECTOR_NAME);
  for (const suffix of [null, 5, "", "x".repeat(75), " Work", "Work ", "x\ny", "x`y", "x@y", "--flag"]) {
    expect(() => validateConnectorNameSuffix(suffix)).toThrow("part after Codex");
  }
  expect(() => validateConnectorNameSuffix("Native")).toThrow("retired");
});

test("stored names survive config loading and strip legacy manual keys", () => {
  const root = join(tmpdir(), `cgw-name-config-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const config = {
    ...defaultConfig("browser-only"),
    browserHost: "launcher" as const,
    browserHostDescriptorPath: join(root, "launcher.json"),
    appName: resolveConnectorIdentity("production", undefined, "Work"),
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  expect(loadConfig().appName).toBe("Codex Work");
  expect(loadConfigForSetup().appName).toBe("Codex Work");

  // An older locally configured name also remains exact; it is not renamed on upgrade.
  config.appName = "Codex Native2 - Work";
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  expect(loadConfigForSetup().appName).toBe("Codex Native2 - Work");

  writeFileSync(join(root, "config.json"), JSON.stringify({ ...config, appName: "Another plugin" }));
  expect(() => loadConfig()).toThrow("must start with Codex");

  writeFileSync(join(root, "config.json"), JSON.stringify({
    ...config,
    appName: "Codex Zero Risk",
    automaticAppName: "Codex Work",
    manualAppName: "Codex Zero Risk",
    browserInteractionMode: "manual",
  }));
  expect(loadConfigForSetup().appName).toBe("Codex Work");
});
