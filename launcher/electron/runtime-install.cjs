const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");

const DEFAULT_SOURCE_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_SOURCE_WAIT_INTERVAL_MS = 50;
const FAST_VERIFY_FILE_COUNT_THRESHOLD = 200;
const SOURCE_VERIFY_CACHE_TTL_MS = 15_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PERSISTED_HASH_MIN_BYTES = 65_536;
const PERSISTED_HASH_CACHE_PATH = path.join(os.tmpdir(), "codex-web-gpt-runtime-hash-cache-v1.json");
const verifiedFileHashes = new Map();
let persistedCacheLoaded = false;
let persistedCacheDirty = false;
let lastVerifiedSourceCache = null;

function loadPersistedHashCache() {
  if (persistedCacheLoaded) return;
  persistedCacheLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(PERSISTED_HASH_CACHE_PATH, "utf8"));
    if (raw && typeof raw === "object") {
      for (const [key, entry] of Object.entries(raw)) {
        if (entry && typeof entry === "object" && typeof entry.sha256 === "string") {
          verifiedFileHashes.set(key, entry);
        }
      }
    }
  } catch {}
}

function savePersistedHashCache() {
  if (!persistedCacheDirty) return;
  persistedCacheDirty = false;
  try {
    const serializable = {};
    for (const [key, entry] of verifiedFileHashes.entries()) {
      if (entry.size >= PERSISTED_HASH_MIN_BYTES) {
        serializable[key] = entry;
      }
    }
    fs.writeFileSync(PERSISTED_HASH_CACHE_PATH, JSON.stringify(serializable));
  } catch {}
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bundleIdFor(files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function validateManifestPath(relativePath) {
  if (typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath === "manifest.json"
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Runtime manifest contains an unsafe file path: ${JSON.stringify(relativePath)}`);
  }
  return relativePath;
}

function readRuntimeManifest(runtimeRoot, { version, platform, arch, bundleId }) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Runtime manifest is invalid: ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedLauncher = `bin/${platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`;
  if (manifest?.schemaVersion !== 2
    || manifest.appVersion !== version
    || manifest.platform !== platform
    || manifest.arch !== arch
    || manifest.launcher !== expectedLauncher
    || manifest.entrypoint !== "app/cli.js"
    || typeof manifest.bunVersion !== "string"
    || typeof manifest.playwright !== "string"
    || !SHA256_PATTERN.test(manifest.bundleId)
    || (bundleId && manifest.bundleId !== bundleId)
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0) {
    const received = manifest && typeof manifest === "object" ? {
      schemaVersion: manifest.schemaVersion,
      appVersion: manifest.appVersion,
      bundleId: manifest.bundleId,
      bunVersion: manifest.bunVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      launcher: manifest.launcher,
      entrypoint: manifest.entrypoint,
      playwright: manifest.playwright,
      fileCount: Array.isArray(manifest.files) ? manifest.files.length : null,
    } : manifest;
    throw new Error(
      `Runtime bundle identity mismatch: expected ${version} ${platform}/${arch}, received ${JSON.stringify(received)}`,
    );
  }

  let previousPath = null;
  const files = manifest.files.map((file, index) => {
    if (!file || typeof file !== "object"
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`Runtime manifest contains an invalid file record at index ${index}`);
    }
    const relativePath = validateManifestPath(file.path);
    if (previousPath !== null && comparePaths(previousPath, relativePath) >= 0) {
      throw new Error(`Runtime manifest file paths are not unique and sorted: ${relativePath}`);
    }
    previousPath = relativePath;
    return { path: relativePath, size: file.size, sha256: file.sha256 };
  });
  if (bundleIdFor(files) !== manifest.bundleId) {
    throw new Error(`Runtime manifest bundleId does not match its file records: ${manifestPath}`);
  }
  return { ...manifest, files };
}

function runtimeFileEntries(runtimeRoot) {
  const entries = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(runtimeRoot, absolutePath).split(path.sep).join("/");
      if (relativePath === "manifest.json") continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      entries.set(relativePath, entry);
    }
  };
  visit(runtimeRoot);
  return entries;
}

function validateRuntimeFile(runtimeRoot, canonicalRoot, file, entry, { verifyHash = true } = {}) {
  const absolutePath = path.join(runtimeRoot, ...file.path.split("/"));
  const isSymlink = entry ? entry.isSymbolicLink() : fs.lstatSync(absolutePath).isSymbolicLink();
  let metadata;
  try {
    metadata = fs.statSync(absolutePath);
  } catch {
    throw new Error(`Runtime bundle file is missing: ${absolutePath}`);
  }
  if (!metadata.isFile()) throw new Error(`Runtime bundle entry is not a file: ${absolutePath}`);
  if (isSymlink) {
    const target = fs.realpathSync(absolutePath);
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`Runtime bundle symlink escapes the bundle: ${absolutePath}`);
    }
  }
  if (metadata.size !== file.size) {
    throw new Error(`Runtime bundle file size mismatch: ${absolutePath}`);
  }
  if (!verifyHash) {
    return;
  }
  loadPersistedHashCache();
  const cached = verifiedFileHashes.get(absolutePath);
  if (cached
    && cached.size === metadata.size
    && cached.mtimeMs === metadata.mtimeMs
    && (cached.ctimeMs === undefined || cached.ctimeMs === metadata.ctimeMs)
    && cached.sha256 === file.sha256) {
    return;
  }
  const sha256 = createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  if (sha256 !== file.sha256) {
    throw new Error(`Runtime bundle file checksum mismatch: ${absolutePath}`);
  }
  verifiedFileHashes.set(absolutePath, {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    sha256,
  });
  if (metadata.size >= PERSISTED_HASH_MIN_BYTES) {
    persistedCacheDirty = true;
  }
}

function inspectRuntimeBundle(runtimeRoot, identity) {
  const manifest = readRuntimeManifest(runtimeRoot, identity);
  const expectedPaths = manifest.files.map(file => file.path);
  const expectedSet = new Set(expectedPaths);
  const paths = runtimeBundlePaths(runtimeRoot, identity.platform);
  const requiredRelativePaths = new Set();
  for (const required of [
    paths.executable,
    paths.entrypoint,
    path.join(runtimeRoot, "app", "browser-helper.cjs"),
    path.join(runtimeRoot, ...manifest.launcher.split("/")),
  ]) {
    const relativePath = path.relative(runtimeRoot, required).split(path.sep).join("/");
    if (!expectedSet.has(relativePath)) {
      throw new Error(`Runtime manifest does not declare required file: ${required}`);
    }
    requiredRelativePaths.add(relativePath);
  }

  const actualEntries = runtimeFileEntries(runtimeRoot);
  const actualPaths = [...actualEntries.keys()].sort(comparePaths);
  const missing = expectedPaths.find(relativePath => !actualEntries.has(relativePath));
  if (missing) throw new Error(`Runtime bundle file is missing: ${path.join(runtimeRoot, ...missing.split("/"))}`);
  const unexpected = actualPaths.find(relativePath => !expectedSet.has(relativePath));
  if (unexpected) {
    throw new Error(`Runtime bundle contains an unmanifested file: ${path.join(runtimeRoot, ...unexpected.split("/"))}`);
  }
  if (actualPaths.length !== expectedPaths.length) {
    throw new Error(`Runtime bundle file count mismatch: expected ${expectedPaths.length}, received ${actualPaths.length}`);
  }

  const canonicalRoot = fs.realpathSync(runtimeRoot);
  const hashEveryFile = manifest.files.length <= FAST_VERIFY_FILE_COUNT_THRESHOLD;
  for (const file of manifest.files) {
    validateRuntimeFile(runtimeRoot, canonicalRoot, file, actualEntries.get(file.path), {
      verifyHash: hashEveryFile || requiredRelativePaths.has(file.path),
    });
  }
  savePersistedHashCache();
  if (identity.platform !== "win32" && (fs.statSync(paths.executable).mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${paths.executable}`);
  }
  return { manifest, runtimeRoot: paths.runtimeRoot };
}

function validateRuntimeBundle(runtimeRoot, identity) {
  return inspectRuntimeBundle(runtimeRoot, identity).runtimeRoot;
}

async function waitForPackagedRuntimeSource({
  app,
  resourcesPath,
  timeoutMs = DEFAULT_SOURCE_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_SOURCE_WAIT_INTERVAL_MS,
}) {
  if (!app.isPackaged) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Packaged runtime source wait requires non-negative timeoutMs and positive intervalMs");
  }
  const source = path.join(resourcesPath, "runtime");
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const inspected = inspectRuntimeBundle(source, identity);
      lastVerifiedSourceCache = {
        source,
        version: identity.version,
        platform: identity.platform,
        arch: identity.arch,
        bundleId: inspected.manifest.bundleId,
        at: Date.now(),
        inspected,
      };
      return inspected.runtimeRoot;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Packaged runtime did not fully materialize within ${timeoutMs}ms: ${detail}`);
}

function inspectCachedRuntimeSource(source, identity) {
  if (lastVerifiedSourceCache
    && lastVerifiedSourceCache.source === source
    && lastVerifiedSourceCache.version === identity.version
    && lastVerifiedSourceCache.platform === identity.platform
    && lastVerifiedSourceCache.arch === identity.arch
    && Date.now() - lastVerifiedSourceCache.at <= SOURCE_VERIFY_CACHE_TTL_MS) {
    try {
      const currentManifest = readRuntimeManifest(source, identity);
      if (currentManifest.bundleId === lastVerifiedSourceCache.bundleId) {
        return lastVerifiedSourceCache.inspected;
      }
    } catch {
      // Fall through to full source inspection.
    }
  }
  const inspected = inspectRuntimeBundle(source, identity);
  lastVerifiedSourceCache = {
    source,
    version: identity.version,
    platform: identity.platform,
    arch: identity.arch,
    bundleId: inspected.manifest.bundleId,
    at: Date.now(),
    inspected,
  };
  return inspected;
}

function ensurePackagedRuntime({ app, coreHome, resourcesPath }) {
  if (!app.isPackaged) return null;
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const source = path.join(resourcesPath, "runtime");
  const sourceBundle = inspectCachedRuntimeSource(source, identity);
  const expectedIdentity = { ...identity, bundleId: sourceBundle.manifest.bundleId };
  const versionsRoot = path.join(coreHome, "versions");
  const destination = path.join(
    versionsRoot,
    `${identity.version}-${identity.platform}-${identity.arch}`,
  );
  if (fs.existsSync(destination)) {
    try {
      return validateRuntimeBundle(destination, expectedIdentity);
    } catch {
      // A terminated installer or external cleanup can leave a version directory present but
      // incomplete. Rebuild the launcher-owned bundle transactionally from the signed package.
    }
  }

  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  let previousMoved = false;
  try {
    fs.cpSync(source, temporary, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    validateRuntimeBundle(temporary, expectedIdentity);
    if (fs.existsSync(destination)) {
      renameAtomicFile(destination, previous);
      previousMoved = true;
    }
    try {
      renameAtomicFile(temporary, destination);
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      if (previousMoved) {
        try {
          renameAtomicFile(previous, destination);
          previousMoved = false;
        } catch (restoreError) {
          throw new Error(
            `Runtime replacement failed: ${error instanceof Error ? error.message : String(error)}`
            + `; previous runtime restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
      }
      throw error;
    }
    if (previousMoved) {
      fs.rmSync(previous, { recursive: true, force: true });
      previousMoved = false;
    }
    try { fs.chmodSync(destination, 0o700); } catch {}
    return runtimeBundlePaths(destination, identity.platform).runtimeRoot;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (previousMoved && fs.existsSync(previous) && !fs.existsSync(destination)) {
      renameAtomicFile(previous, destination);
      previousMoved = false;
    }
  }
}

module.exports = {
  ensurePackagedRuntime,
  validateRuntimeBundle,
  waitForPackagedRuntimeSource,
};
