const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PERSONALIZATION_LIMITS,
  createPersonalizationStore,
} = require("../electron/infra/personalization-store.cjs");

test("launcher personalization store persists, sanitizes, and clamps fields atomically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-personalization-launcher-"));
  const file = path.join(root, "personalization.json");
  try {
    const store = createPersonalizationStore(file);
    assert.deepEqual(store.read(), {
      version: 1,
      enabled: false,
      workspaceMemoryEnabled: true,
      baseTone: "default",
      nickname: "",
      roleOrStack: "",
      aboutYou: "",
      customInstructions: "",
      memories: [],
      updatedAt: null,
    });

    const saved = store.save({
      version: 1,
      enabled: true,
      workspaceMemoryEnabled: false,
      baseTone: "concise_technical",
      nickname: "H".repeat(120),
      roleOrStack: "TS / Electron",
      aboutYou: "Keep it brief",
      customInstructions: "I".repeat(2000),
      memories: [
        { content: "  Use Bun/Node  ", enabled: true },
        { content: "", enabled: true },
      ],
    });

    assert.equal(saved.enabled, true);
    assert.equal(saved.workspaceMemoryEnabled, false);
    assert.equal(saved.baseTone, "concise_technical");
    assert.equal(saved.nickname.length, PERSONALIZATION_LIMITS.nickname);
    assert.equal(saved.customInstructions.length, PERSONALIZATION_LIMITS.customInstructions);
    assert.equal(saved.memories.length, 1);
    assert.equal(saved.memories[0].content, "Use Bun/Node");
    assert.ok(saved.memories[0].id);
    assert.ok(saved.updatedAt);

    const reloaded = createPersonalizationStore(file).read();
    assert.deepEqual(reloaded, saved);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher personalization store rejects non-object payloads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-personalization-invalid-"));
  const file = path.join(root, "personalization.json");
  try {
    const store = createPersonalizationStore(file);
    assert.throws(() => store.save(null), /JSON object/);
    assert.throws(() => store.save([]), /JSON object/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
