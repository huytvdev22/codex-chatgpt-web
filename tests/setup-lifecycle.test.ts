import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { setupProxyIsReady } from "../src/setup";

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test("launcher setup checks browser liveness without requiring an authenticated web session", () => {
  const setupSource = readFileSync(resolve(import.meta.dir, "..", "src", "setup.ts"), "utf8");
  expect(setupSource).toContain("inspectLauncherBrowserHostLiveness(");
  expect(setupSource).not.toMatch(/\binspectLauncherBrowserHost\s*\(/);
});
