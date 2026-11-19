import { cleanLink, cleanText } from "../sources/untrusted-text.ts";
import { parseCreateTransaction, type ParsedCreate } from "./chain-create.ts";
import { SAMPLE_CATCH_UP_DAYS, type ChainCreatesConfig } from "./chain-config.ts";
import { ChainReader, CreditCapReached, RateLimiter } from "./chain-reader.ts";
import { utcDay, type ChainCreateFields, type ChainStore, type CreditLine } from "./chain-store.ts";
import { CREDIT_COST, HeliusError, MAX_SIGNATURES_PAGE, historyCost } from "./helius.ts";
import { randomBytes } from "node:crypto";

/**
 * Chain-sourced creates (phase 3 ticket 20). PumpPortal's feed misses about half of the pump creates, mostly the newer shapes, so the
 * Study reads creates from chain, read-only, through `helius.ts`:
 *   1. Migrated creates: for each migrated mint whose create fields are empty, the mint's earliest transaction is read (one call) and
 *      the create fields and the metadata uri are filled in. A mint PumpPortal delivered whole is never touched.
 *   2. The comparison sample: once a day, every successful signature of the previous UTC day on the mint-authority address is listed,
 *      a uniform random sample is drawn from all of them (migration is not known at draw time and never used), each is read, and the
 *      creates are stored with the day and the sampling weight. The draw is kept, so a read that failed is retried for the same signature.
 * Rows made here carry `source` chain_migrated or chain_sample and are never due for a Snapshot (a late Snapshot would not be at the fixed age).
 * Nothing here fetches metadata (ticket 19) and nothing writes a label (ticket 03). Credits are counted per call (`chain-reader.ts`).
 */

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_NAME_CHARS = 100;
const MAX_SYMBOL_CHARS = 30;
/** Migrated mints looked up per run (each costs 10 credits); the rest wait for the next run or day. */
const MIGRATED_BATCH = 300;
/** Chain errors in a row after which a run stops: the node is down or limiting us. */
const MAX_CONSECUTIVE_ERRORS = 3;
/** After a listing attempt that stopped early (error, cap), the next attempt waits this long. */
const LISTING_HOLD_MS = 30 * 60_000;
/** What a day's listing is guessed to hold before one has been seen: the Dune and Helius counts of 2026-11-10 are 35k to 49k a day. */
const DEFAULT_LISTED_GUESS = 47_000;
const DAY_MS = 86_400_000;

export interface ChainState {
  /** Epoch ms before which the sample listing is not tried again; kept by the caller between runs. */
  listingHoldUntil?: number;
}

export interface ChainCreatesDeps {
  chain: ChainStore;
  config: ChainCreatesConfig;
  now?: () => Date;
  log?: (line: string) => void;
  /** No chain call and no write: reports how many mints and credits a run would use. */
  dryRun?: boolean;
  state?: ChainState;
  /** For tests: the fetch, the limiter's clock and sleep, the seed of the draw, and how many migrated mints one run looks up. */
  fetch?: typeof fetch;
  limiterClock?: { now: () => number; sleep: (ms: number) => Promise<void> };
  seed?: () => number;
  migratedBatch?: number;
}

export interface ChainCreatesReport {
  dryRun: boolean;
  /** Why nothing ran (no key). */
  off: string;
  /** Why the run ended early: `credit cap`, `rate limited`, `chain errors`, `auth`; empty when it finished. */
  stoppedBy: string;
  migrated: { candidates: number; filled: number; unchanged: number; notCreate: number; retry: number };
  sample: { days: Array<{ day: string; listed: number; drawn: number; weight: number; seed: number }>; read: number; stored: number; skipped: number; retry: number; coverage: Record<string, number | null> };
  credits: { run: CreditLine[]; spentToday: number; month: number; cap: number };
  /** Dry run only. */
  would?: { mints: number; sampleReads: number; listingPages: number; credits: number };
}

const emptyReport = (dryRun: boolean): ChainCreatesReport => ({
  dryRun,
  off: "",
  stoppedBy: "",
  migrated: { candidates: 0, filled: 0, unchanged: 0, notCreate: 0, retry: 0 },
  sample: { days: [], read: 0, stored: 0, skipped: 0, retry: 0, coverage: {} },
  credits: { run: [], spentToday: 0, month: 0, cap: 0 },
});

/** mulberry32: a small seeded generator, so a draw can be repeated from the seed recorded with the run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform sample of `n` items without replacement (a partial Fisher-Yates shuffle); every item has the same chance, whatever it is. */
export function drawSample<T>(items: readonly T[], n: number, seed: number): T[] {
  const pool = [...items];
  const take = Math.min(Math.max(0, Math.floor(n)), pool.length);
  const rand = seededRandom(seed);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, take);
}

/** The Study's create fields from a parsed create, with the creator's text cleaned as PumpPortal's is. */
export function toCreateFields(c: ParsedCreate): ChainCreateFields {
  return {
    mint: c.mint,
    name: cleanText(c.name, MAX_NAME_CHARS),
    symbol: cleanText(c.symbol, MAX_SYMBOL_CHARS),
    creator: BASE58_ADDRESS.test(c.user) ? c.user : "",
    uri: cleanLink(c.uri),
    pool: "pump",
    signature: c.signature,
    createdAt: c.createdAt,
    mayhem: c.mayhem,
    cashback: c.cashback,
  };
}

/** The UTC days a daily sample is still owed for: yesterday first, then the earlier catch-up days, skipping those already drawn. */
export function dueSampleDays(chain: ChainStore, now: Date): string[] {
  const days: string[] = [];
  for (let back = 1; back <= 1 + SAMPLE_CATCH_UP_DAYS; back++) {
    const day = utcDay(new Date(now.getTime() - back * DAY_MS));
    if (!chain.dayDrawn(day)) days.push(day);
  }
  return days;
}

const dayStartSec = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) / 1000;

/** What a run would do and cost, without a chain call or a write. */
function estimate(deps: ChainCreatesDeps, now: Date): NonNullable<ChainCreatesReport["would"]> {
  const { chain, config } = deps;
  const mints = Math.min(deps.migratedBatch ?? MIGRATED_BATCH, chain.migratedCandidates(1_000_000).length);
  const due = dueSampleDays(chain, now);
  const guess = chain.lastListed() ?? DEFAULT_LISTED_GUESS;
  const drawnGuess = Math.min(config.chainCreatesSampleSize, guess);
  const listingPages = due.length * (Math.ceil(guess / MAX_SIGNATURES_PAGE) + 1);
  const sampleReads = chain.pendingSampleCount() + due.length * drawnGuess;
  const credits = mints * historyCost("full", 1) + listingPages * CREDIT_COST.signaturesPage + sampleReads * CREDIT_COST.transaction;
  return { mints, sampleReads, listingPages, credits };
}

export async function runChainCreates(deps: ChainCreatesDeps): Promise<ChainCreatesReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const { chain, config } = deps;
  const report = emptyReport(deps.dryRun === true);
  report.credits.cap = config.chainCreatesDailyCreditCap;

  if (deps.dryRun) {
    report.would = estimate(deps, now());
    report.migrated.candidates = report.would.mints;
    report.credits.spentToday = chain.creditsOnDay(utcDay(now()));
    report.credits.month = chain.creditsInMonth(now());
    log(`[chain-creates] dry run: would look up ${report.would.mints} migrated mint(s), list ${report.would.listingPages} page(s), read ${report.would.sampleReads} sampled transaction(s): about ${report.would.credits} credits (cap ${report.credits.cap}, ${report.credits.spentToday} spent today, ${report.credits.month} this month)`);
    return report;
  }
  if (!config.apiKey) {
    report.off = "HELIUS_API_KEY is not set";
    return report;
  }

  const runId = chain.startRun(now(), false);
  const reader = new ChainReader({
    client: { apiKey: config.apiKey, fetch: deps.fetch },
    ledger: chain,
    runId,
    dailyCap: config.chainCreatesDailyCreditCap,
    limiter: new RateLimiter(config.requestsPerSecond, deps.limiterClock?.now, deps.limiterClock?.sleep),
    now,
  });
  const state = deps.state ?? {};
  const touched = new Set<string>();
  let errorsInARow = 0;

  /** Returns true when the run should stop. A retryable error leaves the item for the next run. */
  const failure = (e: unknown, what: string): boolean => {
    if (e instanceof CreditCapReached) {
      report.stoppedBy = "credit cap";
      return true;
    }
    if (!(e instanceof HeliusError)) throw e;
    log(`[chain-creates] ${what}: ${e.kind}: ${e.message}`);
    if (e.kind === "auth") {
      report.stoppedBy = "auth";
      return true;
    }
    if (e.kind === "rate_limited") {
      report.stoppedBy = "rate limited";
      return true;
    }
    errorsInARow++;
    if (errorsInARow >= MAX_CONSECUTIVE_ERRORS) {
      report.stoppedBy = "chain errors";
      return true;
    }
    return false;
  };

  try {
    // 1. the daily sample: list and draw the days still owed, then read what is drawn and unread (also from earlier runs)
    if (now().getTime() >= (state.listingHoldUntil ?? 0)) {
      for (const day of dueSampleDays(chain, now())) {
        try {
          const listed = await listDay(reader, day);
          const seed = deps.seed ? deps.seed() >>> 0 : randomBytes(4).readUInt32LE(0);
          const picked = drawSample(listed, config.chainCreatesSampleSize, seed);
          if (picked.length === 0) {
            log(`[chain-creates] ${day}: no successful signatures listed; nothing to sample`);
            continue;
          }
          chain.saveDraw({ day, runId, seed, listed: listed.length, sampleSize: config.chainCreatesSampleSize, signatures: picked, now: now() });
          report.sample.days.push({ day, listed: listed.length, drawn: picked.length, weight: listed.length / picked.length, seed });
          errorsInARow = 0;
        } catch (e) {
          state.listingHoldUntil = now().getTime() + LISTING_HOLD_MS;
          if (failure(e, `listing ${day}`)) break;
        }
      }
    }
    if (!report.stoppedBy) await readSample(reader, deps, report, touched, failure, () => (errorsInARow = 0));
    // 2. migrated creates
    if (!report.stoppedBy) await fillMigrated(reader, deps, report, failure, () => (errorsInARow = 0));
  } finally {
    // the counts and the PumpPortal coverage of every day read from or drawn in this run
    for (const day of new Set([...report.sample.days.map((d) => d.day), ...touched])) {
      chain.refreshDay(day);
      report.sample.coverage[day] = chain.getDay(day)?.coverage ?? null;
    }
    report.credits.run = chain.creditsOfRun(runId);
    report.credits.spentToday = chain.creditsOnDay(utcDay(now()));
    report.credits.month = chain.creditsInMonth(now());
    chain.finishRun(runId, now(), report.stoppedBy, summaryLine(report));
    // A run that found nothing to do (the usual one, every few minutes) leaves no log lines.
    if (report.credits.run.length > 0 || report.stoppedBy || report.sample.days.length > 0) {
      log(`[chain-creates] ${summaryLine(report)}`);
      for (const l of report.credits.run) log(`[chain-creates] credits ${l.job} ${l.verb}: ${l.calls} call(s), ${l.credits} credit(s)`);
      log(`[chain-creates] credits today ${report.credits.spentToday} of ${report.credits.cap}, month to date ${report.credits.month} of 1,000,000`);
    }
  }
  return report;
}

function summaryLine(r: ChainCreatesReport): string {
  const m = r.migrated;
  const s = r.sample;
  return `migrated: ${m.candidates} candidate(s), ${m.filled} filled, ${m.unchanged} unchanged, ${m.notCreate} not a create, ${m.retry} to retry; sample: ${s.days.map((d) => `${d.day} listed ${d.listed} drawn ${d.drawn}`).join(", ") || "no new draw"}, ${s.read} read, ${s.stored} stored, ${s.skipped} skipped, ${s.retry} to retry${r.stoppedBy ? `; stopped: ${r.stoppedBy}` : ""}`;
}

/** Every successful signature of one UTC day on the mint-authority address, newest first. Paging stops when the page reaches the day before. */
async function listDay(reader: ChainReader, day: string): Promise<string[]> {
  const start = dayStartSec(day);
  const end = start + 86_400;
  const out: string[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await reader.signaturesPage(before);
    for (const s of page) {
      if (s.blockTime === null || s.blockTime >= end || s.blockTime < start) continue;
      if (s.err === null) out.push(s.signature); // a failed transaction is dropped
    }
    const last = page[page.length - 1];
    if (!last || page.length < MAX_SIGNATURES_PAGE) return out;
    if (last.blockTime !== null && last.blockTime < start) return out;
    before = last.signature;
  }
}

type Failure = (e: unknown, what: string) => boolean;

/** Only an answer the node gave and we could not use counts as an attempt; a network error or a rate limit is nobody's fault. */
const countsAsAttempt = (e: unknown): boolean => e instanceof HeliusError && e.kind === "bad_response";

async function readSample(reader: ChainReader, deps: ChainCreatesDeps, report: ChainCreatesReport, touched: Set<string>, failure: Failure, ok: () => void): Promise<void> {
  const { chain } = deps;
  const now = deps.now ?? (() => new Date());
  for (const item of chain.pendingSample(1_000_000)) {
    let tx;
    try {
      tx = await reader.transaction(item.signature);
    } catch (e) {
      if (countsAsAttempt(e)) chain.bumpSample(item.day, item.signature);
      if (!(e instanceof CreditCapReached)) report.sample.retry++;
      if (failure(e, `reading ${item.signature.slice(0, 8)}`)) return;
      continue;
    }
    ok();
    report.sample.read++;
    touched.add(item.day);
    if (tx === null) {
      chain.bumpSample(item.day, item.signature);
      report.sample.retry++;
      continue;
    }
    const parsed = parseCreateTransaction(tx);
    if (parsed.kind === "create") {
      const f = toCreateFields(parsed.create);
      chain.fillCreate(f, "chain_sample", now(), { day: item.day, weight: item.weight }, () => chain.closeSample(item.day, item.signature, "stored", f.mint, ""));
      report.sample.stored++;
    } else {
      chain.closeSample(item.day, item.signature, "skipped", "", parsed.kind === "failed" ? "the transaction failed on chain" : parsed.reason);
      report.sample.skipped++;
    }
  }
}

async function fillMigrated(reader: ChainReader, deps: ChainCreatesDeps, report: ChainCreatesReport, failure: Failure, ok: () => void): Promise<void> {
  const { chain } = deps;
  const now = deps.now ?? (() => new Date());
  const mints = chain.migratedCandidates(deps.migratedBatch ?? MIGRATED_BATCH);
  report.migrated.candidates = mints.length;
  for (const mint of mints) {
    let tx;
    try {
      tx = await reader.earliestTransaction(mint);
    } catch (e) {
      if (countsAsAttempt(e)) chain.markMint(mint, now(), "retry", "the node's answer could not be used");
      if (!(e instanceof CreditCapReached)) report.migrated.retry++;
      if (failure(e, `earliest transaction of ${mint.slice(0, 8)}`)) return;
      continue;
    }
    ok();
    if (tx === null) {
      chain.markMint(mint, now(), "retry", "no transaction found");
      report.migrated.retry++;
      continue;
    }
    const parsed = parseCreateTransaction(tx);
    if (parsed.kind === "create" && parsed.create.mint === mint) {
      const f = toCreateFields(parsed.create);
      const r = chain.fillCreate(f, "chain_migrated", now(), undefined, () => chain.markMint(mint, now(), "done"));
      if (r === "unchanged") report.migrated.unchanged++;
      else report.migrated.filled++;
    } else {
      const reason = parsed.kind === "create" ? "the earliest transaction creates another mint" : parsed.kind === "failed" ? "the earliest transaction failed" : parsed.reason;
      chain.markMint(mint, now(), "not_create", reason);
      report.migrated.notCreate++;
    }
  }
}
