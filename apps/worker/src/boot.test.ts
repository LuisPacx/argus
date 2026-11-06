import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Datastore } from "@argus/core";
import { expect, it } from "vitest";

const workerDir = join(import.meta.dirname, "..");
// A booting worker reconciles leftover Build containers with podman; here that is the fake, so the test never touches a real one.
const ARGUS_PODMAN_BIN = join(workerDir, "../../packages/core/src/testing/fake-podman.mjs");

/** Boots the real worker exactly as `pnpm --filter @argus/worker start` does (plain node), sees a tick, stops it. */
it("the worker starts with plain node, ticks and stops on SIGTERM", async () => {
  const pkg = JSON.parse(readFileSync(join(workerDir, "package.json"), "utf8")) as { scripts: { start: string } };
  const [cmd, ...args] = pkg.scripts.start.split(" ");
  expect(cmd).toBe("node");
  const dir = mkdtempSync(join(tmpdir(), "argus-worker-"));
  const db = join(dir, "argus.db");
  const child = spawn(process.execPath, args, { cwd: workerDir, env: { ...process.env, ARGUS_DB: db, ARGUS_PODMAN_BIN, ARGUS_RSS_FEEDS, ARGUS_INGEST_STANDING: "0" } });
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

// An empty feed list: the booting worker's ingest tick must not reach the network in tests.
const ARGUS_RSS_FEEDS = join(workerDir, "../../packages/core/src/fixtures/no-feeds.json");

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
  const child = spawn(process.execPath, args, { cwd: workerDir, env: { ...process.env, ARGUS_DB: db, ARGUS_CLAUDE_BIN: bin, ARGUS_PODMAN_BIN, ARGUS_RSS_FEEDS, ARGUS_INGEST_STANDING: "0" } });
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
    expect(after.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "interrupted" }]);
    expect(after.getProposal(p.id)).toMatchObject({ status: "shortlisted", specError: "" });
    expect(after.getProposal(p.id)!.brainRunInFlightSince).toBeNull();
    after.close();
  } finally {
    child.kill("SIGKILL");
    await exited; // the worker may still be writing its db into `dir` until it is gone
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

/** SIGTERM during the first draft: the loop must not spawn a second claude, and the worker exits promptly. */
it("SIGTERM during one Spec draft leaves the next shortlisted Proposal undrafted and exits promptly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-worker-loop-"));
  const db = join(dir, "argus.db");
  const started = join(dir, "started");
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nFAKE_CLAUDE_MODE=hang FAKE_CLAUDE_STARTED=${started} FAKE_CLAUDE_LOG=${log} exec ${process.execPath} ${FAKE_CLAUDE} "$@"\n`);
  chmodSync(bin, 0o755);
  const store = Datastore.open(db);
  const ids = ["Alpha Coin", "Beta Coin"].map((name) => {
    const p = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name, ticker: name.slice(0, 4).toUpperCase(), description: "d", evidenceLinks: [] });
    store.transition(p.id, "shortlisted", "operator");
    return p.id;
  });
  store.close();
  const [, ...args] = pkgStart();
  const child = spawn(process.execPath, args, { cwd: workerDir, env: { ...process.env, ARGUS_DB: db, ARGUS_CLAUDE_BIN: bin, ARGUS_PODMAN_BIN, ARGUS_RSS_FEEDS, ARGUS_INGEST_STANDING: "0" } });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(started) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(started)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(4_000);
    await new Promise((r) => setTimeout(r, 300)); // a stray second spawn would show by now
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    const after = Datastore.open(db);
    const runs = ids.map((id) => after.brainRunsFor(id));
    expect(runs.map((r) => r.length).sort()).toEqual([0, 1]);
    expect(runs.flat()).toMatchObject([{ exitStatus: "interrupted" }]);
    for (const id of ids) expect(after.getProposal(id)).toMatchObject({ status: "shortlisted", specError: "", brainRunInFlightSince: null });
    after.close();
  } finally {
    child.kill("SIGKILL");
    await exited; // the worker may still be writing its db into `dir` until it is gone
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

function pkgStart(): string[] {
  const pkg = JSON.parse(readFileSync(join(workerDir, "package.json"), "utf8")) as { scripts: { start: string } };
  return pkg.scripts.start.split(" ");
}
