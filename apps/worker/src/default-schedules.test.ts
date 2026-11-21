import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Datastore, metaGroupConfigFromEnv, metaSummaryConfigFromEnv } from "@argus/core";
import { expect, it } from "vitest";
import { FAKE_CLAUDE, fakeClaudeBin } from "../../../packages/core/src/testing/fake-claude.ts";
import { tempDir } from "../../../packages/core/src/testing/temp.ts";

const workerDir = join(import.meta.dirname, "..");
const ARGUS_PODMAN_BIN = join(workerDir, "../../packages/core/src/testing/fake-podman.mjs");
const ARGUS_RSS_FEEDS = join(workerDir, "../../packages/core/src/fixtures/no-feeds.json");

/**
 * Runs the real worker daemon with the default environment (no ARGUS_RESEARCH_TICK, ARGUS_MEME_IDEAS, ARGUS_MOMENTS, ARGUS_RADAR), every outside URL
 * pointed at a loopback server that answers 404 and a fake claude binary that logs every call, until all `wanted` lines are in its output.
 */
interface DaemonOptions {
  seed?: (store: Datastore) => void;
  /** Extra environment (ARGUS_RADAR=1 for the radar test), set after the defaults are cleared. */
  env?: Record<string, string> | ((dir: string, base: string) => Record<string, string>);
  /** Loopback answers by URL (path and query): a body, or undefined for the default 404. `base` is the server's own URL. */
  route?: (url: string, base: string) => string | undefined;
  /** The fake claude binary, given the temp dir and the call log; the default answers `{}` to everything. */
  claudeBin?: (dir: string, log: string) => string;
  /** Read the database after the worker has stopped. */
  inspect?: (store: Datastore, dir: string) => void;
}

async function runDaemon(wanted: string[], opts: DaemonOptions = {}) {
  const { seed } = opts;
  const dir = tempDir("argus-schedules-");
  let base = "";
  const server = createServer((req, res) => {
    const body = opts.route?.(req.url ?? "", base);
    if (body === undefined) res.writeHead(404).end("");
    else res.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
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
    ARGUS_CLAUDE_BIN: opts.claudeBin ? opts.claudeBin(dir, claudeLog) : fakeClaudeBin(dir, { FAKE_CLAUDE_MODE: "success", FAKE_CLAUDE_RESULT: "{}", FAKE_CLAUDE_LOG: claudeLog }),
    ARGUS_TRENDS_URL: `${base}/trends`,
    ARGUS_DEXSCREENER_URL: base,
    ARGUS_DEXSCREENER_SEARCH_URL: base,
    ARGUS_GITHUB_URL: `${base}/github`,
    ARGUS_GITHUB_SEARCH_URL: `${base}/github`,
    ARGUS_PUMPPORTAL_URL: `ws://127.0.0.1:${port}`,
    ARGUS_JUPITER_URL: base,
    ARGUS_GECKOTERMINAL_URL: base,
    ...(typeof opts.env === "function" ? opts.env(dir, base) : opts.env),
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
  if (opts.inspect) {
    const store = Datastore.open(db);
    try {
      opts.inspect(store, dir);
    } finally {
      store.close();
    }
  }
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
  const { out, calls } = await runDaemon(["[worker] pick outcomes tick: 1 open"], { seed });
  expect(out).toMatch(/\[worker\] pick outcomes tick: 1 open, 1 lookup\(s\) failed/);
  expect(calls).toEqual([]);
}, 40_000);

const LEADER = "Cc".repeat(22);
const leaderPair = (marketCap: number) => ({
  chainId: "solana", dexId: "pumpswap", url: "https://dexscreener.com/solana/PairCat", pairAddress: "PairCat",
  baseToken: { address: LEADER, name: "Chinese Cat", symbol: "CCAT" }, quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL" },
  priceUsd: "0.002", marketCap, fdv: marketCap, volume: { h24: 900_000 }, priceChange: { h24: 12 }, liquidity: { usd: 400_000 }, pairCreatedAt: Date.now() - 6 * 3_600_000,
});
const jupiterList = JSON.stringify([
  { id: LEADER, name: "Chinese Cat", symbol: "CCAT", decimals: 6, holderCount: 9000, fdv: 2_000_000, mcap: 2_000_000, liquidity: 400_000, stats24h: { buyVolume: 450_000, sellVolume: 450_000 }, organicScore: 80, tags: ["unknown"], firstPool: { id: "p", createdAt: "2026-11-20T10:00:00Z" } },
]);
const fixture = (name: string) => readFileSync(join(workerDir, "../../packages/core/src/fixtures", name), "utf8");

/** A fake `claude` that logs each call and answers the meta-group task with a valid grouping and every other task with one plain line. */
const taskAwareClaude = (dir: string, log: string): string => {
  const path = join(dir, "claude");
  const grouping = JSON.stringify({ subjects: [{ name: "Chinese cat", items: ["T1", "H1"] }] });
  writeFileSync(
    path,
    `#!/bin/sh\ncase "$2" in /meta-group*) R='${grouping}' ;; *) R='Chinese cat theme led by a two million dollar token with several copies' ;; esac\nFAKE_CLAUDE_MODE=success FAKE_CLAUDE_RESULT="$R" FAKE_CLAUDE_LOG='${log}' exec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
};

/**
 * Human researcher ticket 14: with every ADR 0017 switch at its default, one worker run starts the ranking, ingest, grouping and summary schedules and each
 * shows its effect (a stored Meta run, Signals in the database, a stored grouping and a stored summary written from a fake Brain's answer), while the agents
 * ADR 0017 turned off make no call, in the same run, with a Meta present (which is what would trigger meme ideas if they were on).
 */
it("at the defaults a tick ranks Metas, ingests, groups and summarises (fake sources, fake Brain) and runs none of the switched-off agents", async () => {
  const seed = (store: Datastore) => {
    for (let i = 0; i < 12; i++) {
      // 12 copies by 12 creators: over the Meta rule's default floor of 10 distinct creators.
      const mint = `Mcat${i}`.padEnd(40, "x") + "pump";
      store.study.recordTokenEvent({ kind: "create", mint, receivedAt: new Date(Date.now() - 30 * 60_000).toISOString(), signature: "", name: "Chinese Cat", symbol: "CCAT", creator: `C${i}`.padEnd(44, "x"), uri: "https://ipfs.io/ipfs/x", pool: "pump" });
    }
  };
  const route = (url: string) => {
    if (url.startsWith("/jup/1h")) return jupiterList;
    if (url.startsWith("/tokens/v1/solana/")) return JSON.stringify([leaderPair(2_000_000)]);
    if (url === "/tech") return fixture("tech-news.rss.xml");
    return undefined;
  };
  const env = (dir: string, base: string) => {
    const feeds = join(dir, "rss-feeds.json");
    writeFileSync(feeds, JSON.stringify([{ id: "rss:tech", label: "TECH", url: `${base}/tech` }]));
    return { ARGUS_RSS_FEEDS: feeds, ARGUS_JUPITER_URL: `${base}/jup/` };
  };
  const wanted = ["[worker] Meta ranking started", "[worker] meta tick:", "[worker] ingest tick:", "[worker] meta group: ai (called", "[worker] meta summary:"];
  let effects: { signals: number; runs: Array<{ task: string; status: string }>; metas: string[]; grouping: string[] | undefined; summaries: number } | undefined;
  const { out, calls } = await runDaemon(wanted, {
    seed,
    route,
    env,
    claudeBin: taskAwareClaude,
    inspect: (store, dir) => {
      const db = new DatabaseSync(join(dir, "argus.db"), { readOnly: true });
      const runs = db.prepare("SELECT task, exit_status AS status FROM brain_runs ORDER BY id").all() as Array<{ task: string; status: string }>;
      db.close();
      const metas = store.latestMetas("24h", 10)?.rows ?? [];
      effects = { signals: store.latestSignals(100).length, runs, metas: metas.map((m) => m.label), grouping: store.meta.latestGrouping()?.answer.subjects.map((s) => s.name), summaries: store.meta.summaries(metas.map((m) => m.key)).size };
    },
  });
  for (const w of wanted) expect(out).toContain(w);
  expect(effects).toMatchObject({ metas: ["Chinese Cat"], grouping: ["Chinese cat"], summaries: 1 });
  expect(effects!.signals).toBeGreaterThan(0);
  expect(effects!.runs.filter((r) => r.task === "meta-group" && r.status === "success").length).toBeGreaterThan(0);
  expect(effects!.runs.filter((r) => r.task === "meta-summary" && r.status === "success").length).toBeGreaterThan(0);
  expect([...new Set(calls.map((c) => (c.argv[1] ?? "").split(/\s/)[0]))].sort()).toEqual(["/meta-group", "/meta-summary"]);
  // The switched-off agents stay off in the same run.
  expect(out).toContain("[worker] Automatic agents off");
  expect(out).toContain("research tick off");
  expect(out).toContain("meme_ideas=off");
  expect(out).toContain("[worker] Moment scanner off");
  expect(out).not.toContain("judge tick");
  expect(out).not.toContain("propose tick");
  expect(effects!.runs.filter((r) => !["meta-group", "meta-summary"].includes(r.task))).toEqual([]);
}, 60_000);

/**
 * Human researcher ticket 14: the radar keeps its own switch (ARGUS_RADAR, default off: ADR 0017 as clarified, ADR 0016). With it on, the worker starts the
 * radar schedule and a tick counts the (loopback) Google Trends reading into the database; it makes no Claude call (radar-name is not built yet:
 * trend-radar ticket 04).
 */
it("with ARGUS_RADAR=1 the radar tick counts readings into the database and makes no Claude call", async () => {
  let readings = 0;
  const { out, calls } = await runDaemon(["[worker] Trend radar started", "[worker] radar tick:"], {
    route: (url) => (url.startsWith("/radar-google") ? fixture("google-trends.rss.xml") : undefined),
    env: (dir, base) => {
      const feeds = join(dir, "radar-feeds.json");
      writeFileSync(feeds, "[]");
      return { ARGUS_RADAR: "1", ARGUS_RADAR_FEEDS: feeds, ARGUS_RADAR_GOOGLE_URL: `${base}/radar-google` };
    },
    inspect: (_store, dir) => {
      const db = new DatabaseSync(join(dir, "argus.db"), { readOnly: true });
      readings = (db.prepare("SELECT count(*) AS n FROM radar_readings").get() as { n: number }).n;
      db.close();
    },
  });
  expect(out).toContain("[worker] Trend radar started");
  expect(readings).toBeGreaterThan(0);
  expect(calls).toEqual([]);
}, 60_000);
