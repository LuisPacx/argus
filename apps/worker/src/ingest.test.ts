import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Datastore } from "@argus/core";
import { fakeClaudeBin } from "../../../packages/core/src/testing/fake-claude.ts";
import { tempDir } from "../../../packages/core/src/testing/temp.ts";
import { expect, it } from "vitest";

const JUDGE_ANSWER = JSON.stringify({ scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 }, rationale: "fake answer" });
const PROPOSE_ANSWER = JSON.stringify({
  name: "Stock Paws",
  ticker: "PAWS",
  tech: "A page that pairs each tokenized stock with a cat verdict",
  whyNow: "Tokenized stocks went live this week",
  interaction: "Visitors pick a stock and vote on the cat's verdict",
  reason: "The Signals cover tokenized stocks; a verdict page gives a reason to return",
  description: "A playful tracker.",
  evidence: ["https://a.example/1", "https://b.example/2", "https://c.example/3"],
});
const workerDir = join(import.meta.dirname, "..");
const fixtures = join(workerDir, "../../packages/core/src/fixtures");
const ARGUS_PODMAN_BIN = join(workerDir, "../../packages/core/src/testing/fake-podman.mjs");

/** Runs the real worker once (plain node, `--once`) against feeds served from loopback fixtures; no external network. */
async function runOnce(feeds: unknown, routes: Record<string, { status: number; body: string }>, envFor: Record<string, string> | ((base: string) => Record<string, string>) = {}, judgeRuns = 5) {
  const env = async (base: string) => (typeof envFor === "function" ? envFor(base) : envFor);
  const dir = tempDir("argus-ingest-");
  const server = createServer((req, res) => {
    const r = routes[req.url ?? ""] ?? routes[(req.url ?? "").split("?")[0]!] ?? { status: 404, body: "" };
    res.writeHead(r.status, { "content-type": "application/rss+xml" }).end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const feedsPath = join(dir, "rss-feeds.json");
  const resolved = (feeds as Array<{ id: string; path: string }>).map((f) => ({ id: f.id, label: f.id.toUpperCase(), url: `${base}${f.path}` }));
  writeFileSync(feedsPath, JSON.stringify(resolved));
  const db = join(dir, "argus.db");
  // Always a fake: the one-shot worker also runs the judge pass, which spawns `claude` for every unjudged Narrative the ingest tick just made,
  // and then the propose pass. The fake answers the first `judgeRuns` calls as the judge and every later one as the propose task.
  const claudeLog = join(dir, "claude-calls.jsonl");
  const sequence = JSON.stringify([...Array.from({ length: judgeRuns }, () => ({})), ...Array.from({ length: 10 }, () => ({ FAKE_CLAUDE_RESULT: PROPOSE_ANSWER }))]);
  const ARGUS_CLAUDE_BIN = fakeClaudeBin(dir, { FAKE_CLAUDE_MODE: "success", FAKE_CLAUDE_RESULT: JUDGE_ANSWER, FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_SEQUENCE: sequence });
  try {
    const child = spawn(process.execPath, ["src/main.ts", "--once"], {
      cwd: workerDir,
      // The standing Sources (Google Trends, DexScreener) are switched off unless a test turns them on against the loopback server.
      env: { ...process.env, ARGUS_DB: db, ARGUS_PODMAN_BIN, ARGUS_CLAUDE_BIN, ARGUS_RSS_FEEDS: feedsPath, ARGUS_INGEST_STANDING: "0", ARGUS_EMBEDDER: "hashing", ARGUS_JUDGE_MIN_SIGNALS: "1", ...(await env(base)) },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    const store = Datastore.open(db);
    try {
      const narratives = store.listNarratives();
      const claudeCalls = existsSync(claudeLog) ? readFileSync(claudeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }) : [];
      return { code, out, listed: store.queryNarratives({ limit: 500 }), signals: store.latestSignals(100), narratives, claudeCalls, scores: narratives.flatMap((n) => store.scoresFor(n.id)), proposals: store.listProposals() };
    } finally {
      store.close();
    }
  } finally {
    server.close();
  }
}

const routes = {
  "/tech": { status: 200, body: readFileSync(join(fixtures, "tech-news.rss.xml"), "utf8") },
  "/other": { status: 200, body: readFileSync(join(fixtures, "other-feed.rss.xml"), "utf8") },
  "/down": { status: 503, body: "" },
};

it("the worker's ingest tick stores Signals from the feed list", async () => {
  const { code, out, signals } = await runOnce([{ id: "rss:tech", path: "/tech" }, { id: "rss:other", path: "/other" }], routes);
  expect(code).toBe(0);
  expect(out).toContain("[worker] ingest tick: 2 source(s), 5 new signal(s)");
  expect(signals.map((s) => s.title)).toEqual([
    "Memecoin season rumours",
    "Unsafe link item",
    "Robots & Rockets: A Launch Day",
    "Cat Elected Mayor of Small Town",
    "Undated item",
  ]);
}, 60_000);

it("the ingest tick clusters the new Signals into Narratives", async () => {
  const { code, out, narratives } = await runOnce([{ id: "rss:tech", path: "/tech" }, { id: "rss:other", path: "/other" }], routes);
  expect(code).toBe(0);
  expect(out).toContain("[worker] cluster: 5 signal(s) clustered, 5 new narrative(s)");
  expect(narratives.map((n) => n.signalCount)).toEqual([1, 1, 1, 1, 1]);
}, 60_000);

it("news-only Narratives (context Signals) are clustered but never judged nor proposed: claude is never spawned (ticket 24)", async () => {
  const { code, out, listed, claudeCalls, scores, proposals } = await runOnce([{ id: "rss:tech", path: "/tech" }, { id: "rss:other", path: "/other" }], routes);
  expect(code).toBe(0);
  expect(out).toContain("[worker] cluster: 5 signal(s) clustered, 5 new narrative(s)");
  expect(out).toContain("[worker] judge tick: 0 scored, 0 refused, 0 failed");
  expect(out).toContain("[worker] propose tick: 0 proposed, 0 refused, 0 failed");
  expect(listed).toHaveLength(5);
  expect(listed.every((n) => n.sourceClass === "context")).toBe(true);
  expect(claudeCalls).toEqual([]);
  expect(scores).toEqual([]);
  expect(proposals).toEqual([]);
}, 60_000);

it("a dry run judges nothing and spawns no claude", async () => {
  const { code, claudeCalls, scores, proposals } = await runOnce([{ id: "rss:tech", path: "/tech" }], routes, { ARGUS_DRY_RUN: "1" });
  expect(code).toBe(0);
  expect(claudeCalls).toEqual([]);
  expect(scores).toEqual([]);
  expect(proposals).toEqual([]);
}, 60_000);

it("a failing feed is logged and the others are still stored", async () => {
  const { code, out, signals } = await runOnce([{ id: "rss:down", path: "/down" }, { id: "rss:other", path: "/other" }], routes);
  expect(code).toBe(0);
  expect(out).toContain("[ingest] rss:down failed");
  expect(out).toContain("503");
  expect(out).toContain("1 new signal(s), 1 source(s) failed");
  expect(signals.map((s) => s.sourceId)).toEqual(["rss:other"]);
}, 60_000);

it("a malformed feed list is reported and does not stop the worker", async () => {
  const { code, out } = await runOnce([{ id: "rss:x", path: "/tech" }], routes, { ARGUS_RSS_FEEDS: join(fixtures, "tech-news.rss.xml") });
  expect(code).toBe(0);
  expect(out).toContain("[worker] ingest tick failed");
}, 60_000);

const MOON = "MoonCatMint1111111111111111111111111111111";
const BOT = "RocketBotMint22222222222222222222222222222";
const extraRoutes = {
  ...routes,
  "/trends?geo=US": { status: 200, body: readFileSync(join(fixtures, "google-trends.rss.xml"), "utf8") },
  "/token-boosts/top/v1": { status: 200, body: readFileSync(join(fixtures, "dexscreener-boosts.json"), "utf8") },
  [`/tokens/v1/solana/${MOON},${BOT}`]: { status: 200, body: readFileSync(join(fixtures, "dexscreener-pairs.json"), "utf8") },
  "/github": { status: 200, body: readFileSync(join(fixtures, "github-search.json"), "utf8") },
};
const extraEnv = (base: string) => ({ ARGUS_INGEST_STANDING: "1", ARGUS_TRENDS_URL: `${base}/trends`, ARGUS_DEXSCREENER_URL: base, ARGUS_GITHUB_URL: `${base}/github` });

it("Google Trends and DexScreener are polled on the same tick, stored, and labelled by Source", async () => {
  const { code, out, signals } = await runOnce([{ id: "rss:other", path: "/other" }], extraRoutes, extraEnv);
  expect(code).toBe(0);
  expect(out).toContain("ingest tick: 4 source(s), 9 new signal(s)");
  expect(signals.map((s) => s.sourceLabel).sort()).toEqual(["DexScreener trending", "DexScreener trending", "GitHub trending", "GitHub trending", "GitHub trending", "Google Trends", "Google Trends", "Google Trends", "RSS:OTHER"]);
  expect(signals.map((s) => s.title)).toEqual(expect.arrayContaining(["moon cat", "Moon Cat ($MCAT)"]));
}, 60_000);

// The same tick, with a market Source (DexScreener) beside the context ones: only the Narratives that hold a DexScreener Signal are judged
// (one run each, no tools, stored with the Rubric version) and then proposed. The fake answers the first MARKET_NARRATIVES calls as the judge.
const MARKET_NARRATIVES = 2;
it("the same one-shot tick then judges and proposes only the Narratives with a market Signal (ticket 24)", async () => {
  const { code, out, listed, claudeCalls, scores, proposals } = await runOnce([{ id: "rss:other", path: "/other" }], extraRoutes, extraEnv, MARKET_NARRATIVES);
  expect(code).toBe(0);
  const market = listed.filter((n) => n.sourceClass === "market");
  expect(market).toHaveLength(MARKET_NARRATIVES);
  expect(listed.length).toBeGreaterThan(market.length); // context-only Narratives exist and are left alone
  expect(out).toContain(`[worker] judge tick: ${market.length} scored, 0 refused, 0 failed`);
  const judgeCalls = claudeCalls.filter((c) => c.argv[1]!.startsWith("/judge\n\n"));
  expect(judgeCalls).toHaveLength(market.length);
  for (const c of judgeCalls) {
    expect(c.argv[c.argv.indexOf("--model") + 1]).toBe("haiku");
    expect(c.argv[c.argv.indexOf("--tools") + 1]).toBe("");
    expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
  }
  expect(scores).toHaveLength(market.length);
  expect(scores.every((s) => s.rubricVersion === 1 && s.total === 7 && s.rationale === "fake answer")).toBe(true);
  expect(new Set(scores.map((s) => s.narrativeId))).toEqual(new Set(market.map((n) => n.id)));
  expect(out).toContain(`[worker] propose tick: ${market.length} proposed, 0 refused, 0 failed`);
  const proposeCalls = claudeCalls.filter((c) => c.argv[1]!.startsWith("/propose\n\n"));
  expect(proposeCalls).toHaveLength(market.length);
  for (const c of proposeCalls) {
    expect(c.argv[c.argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(c.argv[c.argv.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
  }
  expect(proposals).toHaveLength(market.length);
  expect(proposals.every((p) => p.status === "new" && p.name === "Stock Paws" && p.narrativeId !== null && p.scoreId !== null)).toBe(true);
  expect(new Set(proposals.map((p) => p.narrativeId))).toEqual(new Set(market.map((n) => n.id)));
}, 60_000);

it("a rate-limited DexScreener does not stop the other Sources", async () => {
  const limited = { ...extraRoutes, "/token-boosts/top/v1": { status: 429, body: "" } };
  const { code, out, signals } = await runOnce([{ id: "rss:other", path: "/other" }], limited, extraEnv);
  expect(code).toBe(0);
  expect(out).toContain("[ingest] dexscreener:trending failed");
  expect(out).toContain("429");
  expect(out).toContain("1 source(s) failed");
  expect(signals.map((s) => s.sourceId).sort()).toEqual(["github:trending", "github:trending", "github:trending", "rss:other", "trends:google", "trends:google", "trends:google"]);
}, 60_000);

it("the worker logs at boot which Sources are enabled", async () => {
  const on = await runOnce([{ id: "rss:other", path: "/other" }], extraRoutes, extraEnv);
  expect(on.out).toContain("[worker] ingest sources: RSS catalog, trends:google, dexscreener:trending, github:trending");
  const off = await runOnce([{ id: "rss:other", path: "/other" }], extraRoutes, {});
  expect(off.out).toContain("[worker] ingest sources: RSS catalog (standing Sources off: ARGUS_INGEST_STANDING=0; only the exact string 0 turns them off)");
  expect(off.signals.map((s) => s.sourceId)).toEqual(["rss:other"]);
}, 60_000);

it("an empty URL override falls back to the default, it does not switch the Source off", async () => {
  const { code, out, signals } = await runOnce([{ id: "rss:tech", path: "/tech" }], routes, { ARGUS_INGEST_STANDING: "", ARGUS_TRENDS_URL: "", ARGUS_DEXSCREENER_URL: "", ARGUS_GITHUB_URL: "", ARGUS_DRY_RUN: "1" });
  expect(code).toBe(0);
  expect(out).toContain("[worker] ingest sources: RSS catalog, trends:google, dexscreener:trending, github:trending");
  expect(signals).toEqual([]);
}, 60_000);

it("without the semantic model (unreachable host), the tick stores Signals, logs that clustering is skipped, and does not fall back to the lexical embedder", async () => {
  const modelDir = tempDir("argus-models-");
  const { code, out, signals, narratives } = await runOnce([{ id: "rss:tech", path: "/tech" }], routes, (base) => ({
    ARGUS_EMBEDDER: "semantic",
    ARGUS_MODEL_DIR: modelDir,
    ARGUS_MODEL_HOST: base, // answers 404 for the model files
  }));
  expect(code).toBe(0);
  expect(out).toContain("[models] downloading Xenova/gte-small/config.json");
  expect(out).toContain("[worker] cluster: skipped, semantic model unavailable");
  expect(out).not.toMatch(/\[worker\] cluster: \d+ signal/);
  expect(signals.length).toBeGreaterThan(0);
  expect(narratives).toEqual([]);
  expect(readdirSync(modelDir)).toEqual([]);
}, 60_000);

it("a dry run downloads no model", async () => {
  const modelDir = tempDir("argus-models-");
  const { code, out } = await runOnce([{ id: "rss:tech", path: "/tech" }], routes, (base) => ({
    ARGUS_EMBEDDER: "semantic",
    ARGUS_MODEL_DIR: modelDir,
    ARGUS_MODEL_HOST: base,
    ARGUS_DRY_RUN: "1",
  }));
  expect(code).toBe(0);
  expect(out).toContain("[worker] narrative embedder: semantic");
  expect(out).not.toContain("[models]");
  expect(readdirSync(modelDir)).toEqual([]);
}, 60_000);

it("a dry run polls nothing", async () => {
  const { code, out, signals, narratives } = await runOnce([{ id: "rss:tech", path: "/tech" }], routes, { ARGUS_DRY_RUN: "1" });
  expect(code).toBe(0);
  expect(out).toContain("ingest tick: dry-run");
  expect(signals).toEqual([]);
  expect(narratives).toEqual([]);
}, 60_000);
