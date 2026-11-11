import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clusterNewSignals, Datastore, HashingEmbedder } from "@argus/core";
import { messageBody, startFakeAnthropic, type FakeReply } from "../../../packages/core/src/testing/fake-anthropic.ts";
import { fakeClaudeBin } from "../../../packages/core/src/testing/fake-claude.ts";
import { tempDir } from "../../../packages/core/src/testing/temp.ts";
import { afterEach, expect, it } from "vitest";

/**
 * The real worker (`--once`) with the API fallback: the claude it starts is a fake that is always rate-limited, and the API is a fake on
 * loopback. The fallback is off unless ARGUS_API_FALLBACK=1, the key arrives only through the environment here (the test run sets
 * ARGUS_NO_DOTENV, so the Operator's .env is never read), and it must not show up in any claude child or in the worker's output.
 */
const KEY = "sk-ant-test-0123456789abcdef";
const JUDGE_ANSWER = JSON.stringify({ scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 }, rationale: "fake answer" });
const PROPOSE_ANSWER = JSON.stringify({
  name: "Stock Paws",
  ticker: "PAWS",
  tech: "A page that pairs each tokenized stock with a cat verdict",
  whyNow: "Tokenized stocks went live this week",
  reason: "The Signals cover tokenized stocks; a verdict page gives a reason to return",
  description: "A playful tracker.",
  evidence: ["https://a.example/1", "https://b.example/2", "https://c.example/3"],
});
const USAGE = { input_tokens: 2000, output_tokens: 200 };
const workerDir = join(import.meta.dirname, "..");
const ARGUS_PODMAN_BIN = join(workerDir, "../../packages/core/src/testing/fake-podman.mjs");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function runOnce(env: Record<string, string>, replies: FakeReply[] = []) {
  const fake = await startFakeAnthropic();
  cleanups.push(() => fake.close());
  fake.reply(...replies);
  const dir = tempDir("argus-api-fallback-");
  // No feeds to poll: the Narratives the passes work on are seeded straight into the datastore.
  const feedsPath = join(dir, "rss-feeds.json");
  writeFileSync(feedsPath, "[]");
  const db = join(dir, "argus.db");
  const seed = Datastore.open(db);
  for (const [i, title] of ["Tokenized stocks arrive", "Cat elected mayor", "Rockets launch daily"].entries()) {
    seed.recordSignals([{ id: `s:${i}`, sourceId: "rss:a", sourceLabel: "Feed", title, summary: `${title} summary`, url: `https://a.example/${i}`, publishedAt: new Date().toISOString() }]);
  }
  await clusterNewSignals(seed, new HashingEmbedder(), { config: { joinThreshold: 0.99 } });
  seed.close();
  const claudeLog = join(dir, "claude-calls.jsonl");
  const ARGUS_CLAUDE_BIN = fakeClaudeBin(dir, { FAKE_CLAUDE_MODE: "ratelimit", FAKE_CLAUDE_LOG: claudeLog });
  const child = spawn(process.execPath, ["src/main.ts", "--once"], {
    cwd: workerDir,
    env: { ...process.env, ARGUS_DB: db, ARGUS_PODMAN_BIN, ARGUS_CLAUDE_BIN, ARGUS_RSS_FEEDS: feedsPath, ARGUS_INGEST_STANDING: "0", ARGUS_EMBEDDER: "hashing", ARGUS_JUDGE_MIN_SIGNALS: "1", ARGUS_ANTHROPIC_URL: fake.url, ...env },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  const store = Datastore.open(db);
  cleanups.push(async () => store.close());
  const claudeCalls = existsSync(claudeLog) ? readFileSync(claudeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }) : [];
  return { code, out, store, fake, claudeCalls };
}

const judgeThenPropose = (judges: number, proposes: number): FakeReply[] => [
  ...Array.from({ length: judges }, () => ({ status: 200, body: messageBody(JUDGE_ANSWER, USAGE) }) as FakeReply),
  ...Array.from({ length: proposes }, () => ({ status: 200, body: messageBody(PROPOSE_ANSWER, USAGE) }) as FakeReply),
];

it("with ARGUS_API_FALLBACK=1 and a key, a rate-limited subscription is covered by the API for judge and propose, with the key kept out of claude and the output", async () => {
  const { code, out, store, fake, claudeCalls } = await runOnce({ ARGUS_API_FALLBACK: "1", ANTHROPIC_API_KEY: KEY }, judgeThenPropose(3, 3));
  expect(code).toBe(0);
  expect(out).toContain("[worker] API fallback on");
  expect(out).toContain("[worker] judge tick: 3 scored, 0 refused, 0 failed");
  expect(out).toContain("[worker] propose tick: 3 proposed, 0 refused, 0 failed");
  expect(fake.requests).toHaveLength(6);
  for (const r of fake.requests) {
    expect(r.path).toBe("/v1/messages");
    expect(r.body.model).toBe("claude-haiku-5-5");
    expect(JSON.stringify(r.headers)).toContain(KEY); // sent to the endpoint only
  }
  // claude was asked once: its rate limit starts the hold, and the rest of the window goes to the API.
  expect(claudeCalls).toHaveLength(1);
  expect(JSON.stringify(claudeCalls)).not.toContain(KEY);
  expect(claudeCalls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(out).not.toContain(KEY);
  const proposals = store.listProposals();
  expect(proposals).toHaveLength(3);
  for (const p of proposals) {
    expect(p.agentCostUsd).toBe(0);
    expect(p.apiCostUsd).toBeGreaterThan(0);
    expect(store.brainRunsFor(p.id)).toMatchObject([{ task: "propose", backend: "api", model: "claude-haiku-5-5" }]);
  }
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  expect(store.apiSpendSince(since).runs).toBe(6);
  expect(store.researchSpendSince(since)).toMatchObject({ costUsd: 0, chargedUsd: 0 });
}, 60_000);

it("is off by default: with a key in the environment but no switch, a rate-limited subscription just waits and nothing is sent", async () => {
  const { code, out, store, fake } = await runOnce({ ANTHROPIC_API_KEY: KEY }, judgeThenPropose(3, 3));
  expect(code).toBe(0);
  expect(out).toContain("[worker] API fallback off");
  expect(out).toContain("[worker] judge tick: 0 scored, 0 refused, 0 failed, stopped: rate-limited");
  expect(fake.requests).toHaveLength(0);
  expect(store.listProposals()).toHaveLength(0);
  expect(out).not.toContain(KEY);
}, 60_000);

it("switched on without a key, it says so once and stays off", async () => {
  const { code, out, fake } = await runOnce({ ARGUS_API_FALLBACK: "1", ANTHROPIC_API_KEY: "" }, judgeThenPropose(3, 3));
  expect(code).toBe(0);
  expect(out).toMatch(/ARGUS_API_FALLBACK=1 but ANTHROPIC_API_KEY is not set/);
  expect(out).toContain("stopped: rate-limited");
  expect(fake.requests).toHaveLength(0);
}, 60_000);

it("a daily cap too small for even one call keeps the API silent: research waits as a rate limit", async () => {
  const { code, out, fake } = await runOnce({ ARGUS_API_FALLBACK: "1", ANTHROPIC_API_KEY: KEY, ARGUS_API_DAILY_USD: "0.0001" }, judgeThenPropose(3, 3));
  expect(code).toBe(0);
  expect(out).toContain("stopped: rate-limited");
  expect(fake.requests).toHaveLength(0);
}, 60_000);

it("a cap above the one in code is a startup error, never honoured", async () => {
  const { code, out } = await runOnce({ ARGUS_API_FALLBACK: "1", ANTHROPIC_API_KEY: KEY, ARGUS_API_DAILY_USD: "50" });
  expect(code).not.toBe(0);
  expect(out).toMatch(/ARGUS_API_DAILY_USD must be at most/);
  expect(out).not.toContain(KEY);
}, 60_000);

it("a dry run with the fallback on logs the API request it would send, and spawns and sends nothing", async () => {
  const { code, out, fake, claudeCalls, store } = await runOnce({ ARGUS_API_FALLBACK: "1", ARGUS_DRY_RUN: "1" }, judgeThenPropose(3, 3));
  expect(code).toBe(0);
  expect(out).toMatch(/\[brain\] dry-run: POST http:\/\/127\.0\.0\.1:\d+\/v1\/messages model=claude-haiku-5-5/);
  expect(claudeCalls).toEqual([]);
  expect(fake.requests).toHaveLength(0);
  expect(store.listProposals()).toHaveLength(0);
}, 60_000);
