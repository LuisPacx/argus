import { existsSync } from "node:fs";

// Captured at load so the helper keeps real time when a test fakes the global timers.
const realSetTimeout = globalThis.setTimeout;

/**
 * Resolves once `path` exists. This is how tests wait on a child process (the fake `claude` writes a marker file when it is
 * ready) instead of guessing how long node takes to start. The deadline only bounds a hung test; it is never what a passing
 * test waits for.
 */
export async function untilExists(path: string, deadlineMs = 20_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
}
