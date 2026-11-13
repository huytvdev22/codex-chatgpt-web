import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateCodexIntegration,
  deactivateCodexIntegration,
  installCodexIntegration,
  reconcileCodexModelCatalogConfig,
  removeCodexModelCatalogConfig,
  syncCodexModelCatalogConfig,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { ModelCatalog } from "../src/models/model-catalog";
import { defaultConfig } from "../src/config";

test("syncCodexModelCatalogConfig adds model_catalog_json without altering other config lines", () => {
  const tempDir = join(tmpdir(), `codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  process.env.CODEX_HOME = tempDir;

  try {
    const configPath = join(tempDir, "config.toml");
    const catalogPath = join(tempDir, "catalog.json");
    const initialConfig = `model = "gpt-5.6-sol"
openai_base_url = "http://127.0.0.1:17842/v1"

[features]
multi_agent = true
`;
    writeFileSync(configPath, initialConfig);

    const changed = syncCodexModelCatalogConfig(catalogPath);
    expect(changed).toBe(true);

    const updated = readFileSync(configPath, "utf8");
    expect(updated).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
    expect(updated).toContain('model = "gpt-5.6-sol"');
    expect(updated).toContain('openai_base_url = "http://127.0.0.1:17842/v1"');
    expect(updated).toContain("[features]");
    expect(updated).toContain("multi_agent = true");

    // Idempotent: running again should not change or duplicate
    const changedAgain = syncCodexModelCatalogConfig(catalogPath);
    expect(changedAgain).toBe(false);
    const updatedAgain = readFileSync(configPath, "utf8");
    expect(updatedAgain).toBe(updated);

    // Remove catalog config
    const removed = removeCodexModelCatalogConfig(catalogPath);
    expect(removed).toBe(true);
    const afterRemove = readFileSync(configPath, "utf8");
    expect(afterRemove).not.toContain("model_catalog_json");
    expect(afterRemove).toContain('openai_base_url = "http://127.0.0.1:17842/v1"');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.CODEX_HOME;
  }
});

test("ensureManagedModelCatalogFile generates a valid catalog containing all active M365 models", () => {
  const tempDir = join(tmpdir(), `codex-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const catalogPath = join(tempDir, "test-catalog.json");

  try {
    const config = defaultConfig("browser-only");
    const catalog = ModelCatalog.getInstance();
    catalog.ensureManagedCatalogFile(config, catalogPath, true);
    expect(existsSync(catalogPath)).toBe(true);

    const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
    expect(Array.isArray(raw.models)).toBe(true);
    const slugs = raw.models.map((m: { slug: string }) => m.slug);

    expect(slugs).toContain("m365-copilot/gpt-5.6");
    expect(slugs).toContain("m365-copilot");

    // Khi catalog cũ thiếu "image" ở root route hoặc còn sót native model cũ, ensure phải rebuild sạch
    const stale = {
      models: [
        { slug: "gpt-5.6-sol", visibility: "list" },
        ...raw.models.map((m: Record<string, unknown>) =>
          m.slug === "m365-copilot" ? { ...m, input_modalities: ["text"] } : m
        ),
      ],
    };
    writeFileSync(catalogPath, JSON.stringify(stale, null, 2));
    catalog.ensureManagedCatalogFile(config, catalogPath, false);

    const repaired = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models: Array<{ slug: string; input_modalities?: string[] }>;
    };
    const rootM365 = repaired.models.find(m => m.slug === "m365-copilot");
    expect(rootM365?.input_modalities).toEqual(["text", "image"]);
    expect(repaired.models.some(m => m.slug === "gpt-5.6-sol")).toBe(false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcileCodexModelCatalogConfig and uninstall strip managed catalog and adapter model while preserving user projects", () => {
  const base = join(tmpdir(), `codex-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const coreHome = join(base, "core");
  const codexHome = join(base, "codex");
  mkdirSync(coreHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const prevAppHome = process.env.CODEX_CHATGPT_WEB_HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = coreHome;
  process.env.CODEX_HOME = codexHome;

  try {
    const configPath = join(codexHome, "config.toml");
    const managedCatalogPath = ModelCatalog.getInstance().getManagedCatalogPath();
    const initialConfig = [
      `model_catalog_json = ${JSON.stringify(managedCatalogPath)}`,
      'model = "m365-copilot/gpt-5.6"',
      'model_reasoning_effort = "high"',
      '[projects."/tmp/my-repo"]',
      'trust_level = "trusted"',
      "",
    ].join("\n");
    writeFileSync(configPath, initialConfig);

    // Chưa cài integration -> reconcile không tự sửa config.toml
    expect(reconcileCodexModelCatalogConfig(managedCatalogPath)).toBe(false);

    installCodexIntegration(defaultConfig("browser-only"));
    expect(reconcileCodexModelCatalogConfig(managedCatalogPath)).toBe(false); // đã có sẵn catalogPath

    // Khi disconnect / deactivate -> gỡ managed catalog và adapter model, giữ nguyên [projects.*]
    deactivateCodexIntegration();
    const afterDisconnect = readFileSync(configPath, "utf8");
    expect(afterDisconnect).not.toContain("model_catalog_json");
    expect(afterDisconnect).not.toContain("m365-copilot/gpt-5.6");
    expect(afterDisconnect).toContain('[projects."/tmp/my-repo"]');
    expect(afterDisconnect).toContain('trust_level = "trusted"');

    // Khi paused -> reconcile không được chèn lại model_catalog_json
    expect(reconcileCodexModelCatalogConfig(managedCatalogPath)).toBe(false);
    expect(readFileSync(configPath, "utf8")).not.toContain("model_catalog_json");

    // Khi activate lại -> đồng bộ lại model_catalog_json
    activateCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toContain(`model_catalog_json = ${JSON.stringify(managedCatalogPath)}`);

    // Khi uninstall -> gỡ sạch openai_base_url, model_catalog_json và model adapter (top-level trước các [table])
    writeFileSync(
      configPath,
      `model = "m365-copilot/gpt-5.6"\n${readFileSync(configPath, "utf8")}`,
    );
    uninstallCodexIntegration();
    const afterUninstall = readFileSync(configPath, "utf8");
    expect(afterUninstall).not.toContain("openai_base_url");
    expect(afterUninstall).not.toContain("model_catalog_json");
    expect(afterUninstall).not.toContain("m365-copilot/gpt-5.6");
    expect(afterUninstall).toContain('[projects."/tmp/my-repo"]');
  } finally {
    rmSync(base, { recursive: true, force: true });
    if (prevAppHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = prevAppHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
  }
});
