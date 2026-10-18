import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
const runtimeBundle = join(scratch, "runtime");

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): bun ${args.join(" ")}`);
}

try {
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "launcher:audit"]);
  await run(["run", "check:architecture"]);
  await run([
    "test",
    "tests/m365-architecture-integrity.test.ts",
    "tests/chatgpt-web-adapter.test.ts",
    "tests/gemini-web-adapter.test.ts",
    "tests/qwen-web-adapter.test.ts",
    "tests/qwen-conversation-store.test.ts",
    "tests/chatgpt-conversation-store.test.ts",
    "tests/chatgpt-web-markdown.test.ts",
  ]);
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
