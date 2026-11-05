import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { leakedIn } from "./no-leaked-fakes.ts";
import { registryDirFor } from "./run-registry.mjs";
import { untilExists } from "./wait.ts";

describe("the leak guard only claims fakes started under its own test run", () => {
  it("a fake records itself with the run whose process is its ancestor, not with another run's registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-registry-test-"));
    const started = join(dir, "started");
    // This test's own worker is the fake's ancestor, so its registry is the one the fake must pick. The other is some other run.
    const mine = registryDirFor(process.pid);
    const other = registryDirFor(process.pid + 1_000_000);
    mkdirSync(mine, { recursive: true });
    mkdirSync(other, { recursive: true });
    const child = spawn(join(import.meta.dirname, "fake-wrangler.mjs"), [], {
      env: { PATH: process.env.PATH, FAKE_WRANGLER_HANG: "1", FAKE_WRANGLER_STARTED: started },
      stdio: "ignore",
      detached: true,
    });
    try {
      await untilExists(started);
      expect(readdirSync(mine)).toEqual([String(child.pid)]);
      expect(leakedIn(mine).map((l) => l.pid)).toEqual([child.pid]);
      // The other run neither holds the fake nor would report it.
      expect(readdirSync(other)).toEqual([]);
      expect(leakedIn(other)).toEqual([]);
    } finally {
      process.kill(child.pid!, "SIGKILL");
      rmSync(mine, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a recorded process that is gone, or whose pid was reused by something else, is not a leak", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-registry-test-"));
    try {
      // This very test process, recorded with a start time that is not its own (a reused pid), and a pid that does not exist.
      writeFileSync(join(dir, String(process.pid)), "1");
      writeFileSync(join(dir, "2000000000"), "1");
      expect(leakedIn(dir)).toEqual([]);
      expect(leakedIn(join(dir, "missing"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
