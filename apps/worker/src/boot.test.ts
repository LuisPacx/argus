import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const workerDir = join(import.meta.dirname, "..");

/** Boots the real worker exactly as `pnpm --filter @argus/worker start` does (plain node), sees a tick, stops it. */
it("the worker starts with plain node, ticks and stops on SIGTERM", async () => {
  const pkg = JSON.parse(readFileSync(join(workerDir, "package.json"), "utf8")) as { scripts: { start: string } };
  const [cmd, ...args] = pkg.scripts.start.split(" ");
  expect(cmd).toBe("node");
  const db = join(mkdtempSync(join(tmpdir(), "argus-worker-")), "argus.db");
  const child = spawn(process.execPath, args, { cwd: workerDir, env: { ...process.env, ARGUS_DB: db } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  try {
    const deadline = Date.now() + 15_000;
    while (!out.includes("[worker] tick ") && child.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(out).toContain("[worker] tick ");
  } finally {
    child.kill("SIGTERM");
  }
  expect(await exited).toBe(0);
  expect(out).toContain("[worker] stopped");
}, 30_000);
