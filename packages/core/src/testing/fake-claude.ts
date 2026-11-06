import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Absolute path of the shared fake `claude` executable (see fake-claude.mjs). */
export const FAKE_CLAUDE = join(import.meta.dirname, "fake-claude.mjs");

/**
 * An executable `claude` in `dir` that runs the fake with `env` set, for code that takes its binary from ARGUS_CLAUDE_BIN and hands
 * its child a scrubbed environment (the worker): the fake's FAKE_CLAUDE_* settings cannot ride the environment there, so they are baked in.
 * Returns its path. Every test that starts the worker must pass this (or its own fake) as ARGUS_CLAUDE_BIN; a worker started without
 * one would resolve `claude` on PATH, which the test run's guard turns into a failure (see no-leaked-fakes.ts).
 */
export function fakeClaudeBin(dir: string, env: Record<string, string> = {}): string {
  const path = join(dir, "claude");
  const sets = Object.entries(env).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`);
  writeFileSync(path, `#!/bin/sh\n${sets.join(" ")} exec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}
