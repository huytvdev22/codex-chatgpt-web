import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCodexModelCatalogConfig,
  removeCodexModelCatalogConfig,
  syncCodexModelCatalogConfig,
} from "../src/codex-integration";
import {
  ensureManagedModelCatalogFile,
  getFallbackNativeCatalog,
  getManagedModelCatalogPath,
} from "../src/model-catalog";
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

test("ensureManagedModelCatalogFile generates a valid catalog containing all 7 M365 models", () => {
  const tempDir = join(tmpdir(), `codex-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const catalogPath = join(tempDir, "test-catalog.json");

  try {
    const config = defaultConfig("full");
    ensureManagedModelCatalogFile(config, catalogPath, true);
    expect(existsSync(catalogPath)).toBe(true);

    const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
    expect(Array.isArray(raw.models)).toBe(true);
    const slugs = raw.models.map((m: { slug: string }) => m.slug);

    expect(slugs).toContain("m365-copilot/auto");
    expect(slugs).toContain("m365-copilot/gpt-5.6-think");
    expect(slugs).toContain("m365-copilot/gpt-5.6-quick");
    expect(slugs).toContain("m365-copilot/think");
    expect(slugs).toContain("m365-copilot/quick");
    expect(slugs).toContain("m365-copilot/gpt-5");
    expect(slugs).toContain("m365-copilot/fast");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
