import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Datastore } from "@argus/core";
import { expect, it } from "vitest";

const workerDir = join(import.meta.dirname, "..");

/** Boots the real worker exactly as `pnpm --filter @argus/worker start` does (plain node), sees a tick, stops it. */
it("the worker starts with plain node, ticks and stops on SIGTERM", async () => {
  const pkg = JSON.parse(readFileSync(join(workerDir, "package.json"), "utf8")) as { scripts: { start: string } };
  const [cmd, ...args] = pkg.scripts.start.split(" ");
  expect(cmd).toBe("node");
  const dir = mkdtempSync(join(tmpdir(), "argus-worker-"));
  const db = join(dir, "argus.db");
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
  try {
    expect(await exited).toBe(0);
    expect(out).toContain("[worker] stopped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

const FAKE_CLAUDE = join(workerDir, "../../packages/core/src/testing/fake-claude.mjs");

/** A hung claude child must not outlive the worker: SIGTERM to the worker kills it before exit. */
it("SIGTERM kills a live claude child before the worker exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-worker-kill-"));
  const db = join(dir, "argus.db");
  const started = join(dir, "started");
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh\nFAKE_CLAUDE_MODE=hang-stubborn FAKE_CLAUDE_STARTED=${started} FAKE_CLAUDE_LOG=${log} exec ${process.execPath} ${FAKE_CLAUDE} "$@"\n`,
  );
  chmodSync(bin, 0o755);
  const store = Datastore.open(db);
  const p = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Kill Me", ticker: "KILL", description: "d", evidenceLinks: [] });
  store.transition(p.id, "shortlisted", "operator");
  store.close();
  const [, ...args] = pkgStart();
  const child = spawn(process.execPath, args, { cwd: workerDir, env: { ...process.env, ARGUS_DB: db, ARGUS_CLAUDE_BIN: bin } });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(started) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(started)).toBe(true);
    await new Promise((r) => setTimeout(r, 200)); // the fake ignores SIGTERM from here on, so only SIGKILL can stop it
    const claudePid = (JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!) as { pid: number }).pid;
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(() => process.kill(claudePid, 0)).toThrow();
    const after = Datastore.open(db);
    expect(after.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "failed" }]);
    expect(after.getProposal(p.id)!.brainRunInFlightSince).toBeNull();
    after.close();
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

function pkgStart(): string[] {
  const pkg = JSON.parse(readFileSync(join(workerDir, "package.json"), "utf8")) as { scripts: { start: string } };
  return pkg.scripts.start.split(" ");
}
