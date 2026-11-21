import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Datastore, metaGroupConfigFromEnv, metaSummaryConfigFromEnv } from "@argus/core";
import { expect, it } from "vitest";
import { fakeClaudeBin } from "../../../packages/core/src/testing/fake-claude.ts";
import { tempDir } from "../../../packages/core/src/testing/temp.ts";

const workerDir = join(import.meta.dirname, "..");
const ARGUS_PODMAN_BIN = join(workerDir, "../../packages/core/src/testing/fake-podman.mjs");
const ARGUS_RSS_FEEDS = join(workerDir, "../../packages/core/src/fixtures/no-feeds.json");

/**
 * Runs the real worker daemon with the default environment (no ARGUS_RESEARCH_TICK, ARGUS_MEME_IDEAS, ARGUS_MOMENTS, ARGUS_RADAR), every outside URL
 * pointed at a loopback server that answers 404 and a fake claude binary that logs every call, until all `wanted` lines are in its output.
 */
async function runDaemon(wanted: string[], seed?: (store: Datastore) => void) {
  const dir = tempDir("argus-schedules-");
  const server = createServer((_req, res) => res.writeHead(404).end(""));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const db = join(dir, "argus.db");
  if (seed) {
    const store = Datastore.open(db);
    try {
      seed(store);
    } finally {
      store.close();
    }
  }
  const claudeLog = join(dir, "claude-calls.jsonl");
  const env: Record<string, string | undefined> = { ...process.env, ARGUS_DB: db, ARGUS_PODMAN_BIN, ARGUS_RSS_FEEDS, ARGUS_EMBEDDER: "hashing" };
  for (const k of ["ARGUS_RESEARCH_TICK", "ARGUS_MEME_IDEAS", "ARGUS_MOMENTS", "ARGUS_RADAR", "ARGUS_INGEST_STANDING", "ARGUS_DRY_RUN", "ARGUS_META_GROUP_AI", "ARGUS_META_INTERVAL_MINUTES"]) delete env[k];
  Object.assign(env, {
    ARGUS_CLAUDE_BIN: fakeClaudeBin(dir, { FAKE_CLAUDE_MODE: "success", FAKE_CLAUDE_RESULT: "{}", FAKE_CLAUDE_LOG: claudeLog }),
    ARGUS_TRENDS_URL: `${base}/trends`,
    ARGUS_DEXSCREENER_URL: base,
    ARGUS_DEXSCREENER_SEARCH_URL: base,
    ARGUS_GITHUB_URL: `${base}/github`,
    ARGUS_GITHUB_SEARCH_URL: `${base}/github`,
    ARGUS_PUMPPORTAL_URL: `ws://127.0.0.1:${port}`,
    ARGUS_JUPITER_URL: base,
    ARGUS_GECKOTERMINAL_URL: base,
  });
  const child = spawn(process.execPath, ["src/main.ts"], { cwd: workerDir, env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  try {
    const deadline = Date.now() + 25_000;
    while (!wanted.every((w) => out.includes(w)) && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  } finally {
    child.kill("SIGTERM");
    await exited;
    server.close();
  }
  const calls = existsSync(claudeLog) ? readFileSync(claudeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] }) : [];
  return { out, calls };
}

/**
 * Human researcher ticket 01: with the default environment the automatic Claude runs are off but the Meta ranking and the ingest tick still start
 * and run, and the Meta group and summary haiku tasks stay enabled (their own caps, not the ADR 0017 switches).
 */
it("with the default environment the Meta ranking and ingest run on their schedules and no judge or propose run starts", async () => {
  expect(metaGroupConfigFromEnv({}).enabled).toBe(true);
  expect(metaSummaryConfigFromEnv({}).maxRunsPerDay).toBeGreaterThan(0);
  const wanted = ["[worker] Meta ranking started", "[worker] meta tick:", "[worker] ingest tick:", "[worker] pick outcomes started", "research tick off"];
  const { out, calls } = await runDaemon(wanted);
  for (const w of wanted) expect(out).toContain(w);
  expect(out).toContain("[worker] Automatic agents off");
  expect(out).not.toContain("judge tick");
  expect(out).not.toContain("propose tick");
  expect(out).toContain("meme_ideas=off");
  expect(calls.filter((c) => /^\/(judge|propose|meme-ideas)\b/.test(c.argv[1] ?? ""))).toEqual([]);
}, 40_000);

/** Human researcher ticket 04: the pick outcomes job runs inside the real worker, where a Brain is reachable (the fake claude binary), and never touches it. */
it("the pick outcomes job runs in the worker on an unfinished Pick and makes no Claude call", async () => {
  const ca = `${"2".repeat(36)}pump`;
  const seed = (store: Datastore) => {
    store.recordPick({ snapshot: { ca, name: "Coin", symbol: "CN", marketCapUsd: 50_000, liquidityUsd: 12_000, pairCreatedAt: null, ageMinutes: 10, bondedAtPick: false, bondedBasis: "", venue: "pumpfun" }, reason: "", topic: "" });
  };
  const { out, calls } = await runDaemon(["[worker] pick outcomes tick: 1 open"], seed);
  expect(out).toMatch(/\[worker\] pick outcomes tick: 1 open, 1 lookup\(s\) failed/);
  expect(calls).toEqual([]);
}, 40_000);
