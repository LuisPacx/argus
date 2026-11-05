import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Temp dirs and files for tests: removed when the test file finishes, so a test never leaves anything in the temp dir.
 * Import this from a test file (or a helper one imports) and use it instead of `mkdtempSync(join(tmpdir(), ...))`.
 */
const made: string[] = [];
afterAll(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A new empty directory in the temp dir. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A path in the temp dir that does not exist yet; whatever ends up there is removed at the end. */
export function tempPath(label: string, extension = ""): string {
  const path = join(tmpdir(), `argus-${label}-${process.pid}-${Math.random().toString(36).slice(2)}${extension}`);
  made.push(path);
  return path;
}
