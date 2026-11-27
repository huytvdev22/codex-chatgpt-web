import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
const runtimeBundle = join(scratch, "runtime");
const isolatedHome = join(scratch, "codex-home");
const PER_FILE_TEST_TIMEOUT_MS = 45_000;

async function run(
  args: string[],
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    env: env ?? process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {}
      }, timeoutMs)
    : undefined;

  try {
    const exitCode = await child.exited;
    if (timedOut) {
      throw new Error(`Verification command timed out after ${timeoutMs}ms: bun ${args.join(" ")}`);
    }
    if (exitCode !== 0) {
      throw new Error(`Verification command failed (${exitCode}): bun ${args.join(" ")}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runIsolatedTestFiles(): Promise<void> {
  const testsDir = join(root, "tests");
  const testFiles = readdirSync(testsDir)
    .filter((entry) => entry.endsWith(".test.ts"))
    .sort()
    .map((entry) => `tests/${entry}`);

  const isolatedTestEnv = process.env.CODEX_CHATGPT_WEB_HOME
    ? process.env
    : { ...process.env, CODEX_CHATGPT_WEB_HOME: isolatedHome };

  for (const file of testFiles) {
    const startedAt = Date.now();
    process.stdout.write(`[verify] Running ${file}...\n`);
    await run(
      ["test", "--timeout", "30000", file],
      PER_FILE_TEST_TIMEOUT_MS,
      isolatedTestEnv,
    );
    process.stdout.write(`[verify] Passed ${file} (${Date.now() - startedAt}ms)\n`);
  }
}

try {
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "launcher:audit"]);
  await run(["run", "check:architecture"]);
  await runIsolatedTestFiles();
  await run(["run", "launcher:typecheck"]);
  await run(["run", "launcher:build"]);
  await run(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await run([
    "run",
    "scripts/generate-third-party-notices.ts",
    join(scratch, "THIRD_PARTY_NOTICES.txt"),
    "--include-launcher",
  ]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
