import type { DatabaseSync } from "node:sqlite";
import { cleanLine } from "../meme/ideas.ts";
import type { DexPair } from "../sources/dexscreener.ts";

/**
 * Picks (human researcher ticket 03): a coin the Operator names by its contract address (CA), recorded with a snapshot of the coin taken
 * at that moment. The Pick is the Operator's label-bearing choice, so a row is never changed after it is written (a database trigger
 * refuses any update); what became of the coin later is a separate table (ticket 04). Every pasted text is untrusted: the CA must match a
 * plain address pattern, the reason and topic are flattened to one line and cut, and the page shows all of it as escaped text.
 */

/** The longest reason and topic, in characters after cleaning (the form's `maxlength`). */
export const PICK_REASON_MAX_CHARS = 300;
export const PICK_TOPIC_MAX_CHARS = 60;
/** The most addresses one submission may carry; the rest are reported as skipped, not looked up. */
export const PICK_MAX_CAS = 10;
/** The same CA picked again inside this long is refused. */
export const PICK_DUPLICATE_MS = 24 * 3_600_000;
/** Rows `GET /api/picks` returns. */
export const PICK_LIST_LIMIT = 50;

// A Solana address is base58 (no 0, O, I, l), 32 to 44 characters.
const CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SEPARATOR_RE = /[\s,;]+/;

export const isCa = (text: string): boolean => CA_RE.test(text);

/** The addresses in pasted text: split on whitespace, commas and semicolons, empty parts dropped, repeats of the same text dropped, at most `PICK_MAX_CAS`. */
export function splitCas(raw: unknown): { cas: string[]; skipped: number } {
  if (typeof raw !== "string") return { cas: [], skipped: 0 };
  const parts = [...new Set(raw.slice(0, 20_000).split(SEPARATOR_RE).filter((p) => p !== ""))];
  return { cas: parts.slice(0, PICK_MAX_CAS), skipped: Math.max(0, parts.length - PICK_MAX_CAS) };
}

/** The optional reason as stored: one cleaned line cut to the limit; "" when empty. */
export const cleanReason = (raw: unknown): string => (typeof raw === "string" ? cleanLine(raw, PICK_REASON_MAX_CHARS) : "");
/** The optional topic as stored: one cleaned line cut to the limit; "" when empty. */
export const cleanTopic = (raw: unknown): string => (typeof raw === "string" ? cleanLine(raw, PICK_TOPIC_MAX_CHARS) : "");

/** The coin as DexScreener showed it when it was picked. */
export interface PickSnapshot {
  ca: string;
  name: string;
  symbol: string;
  /** USD, or null when DexScreener gave none. */
  marketCapUsd: number | null;
  liquidityUsd: number;
  /** When the pair was created (ISO), or null when unknown. */
  pairCreatedAt: string | null;
  /** The coin's age in minutes at the Pick, or null when the pair's age is unknown. */
  ageMinutes: number | null;
  /** True when the coin has left its launchpad curve for an exchange pool. */
  bonded: boolean;
}

export interface ResearchPick extends PickSnapshot {
  id: number;
  reason: string;
  topic: string;
  /** The moment of recording (ISO). Never changed. */
  createdAt: string;
}

export type SnapshotResult = { ok: true; snapshot: PickSnapshot } | { ok: false; message: string };

/** The snapshot of one coin from the pairs DexScreener gave for its address; a plain message when there is no usable pair. */
export function snapshotFromPairs(ca: string, pairs: readonly DexPair[], now: Date): SnapshotResult {
  const mine = pairs.filter((p) => p.tokenAddress === ca);
  if (mine.length === 0) return { ok: false, message: "DexScreener does not know this address" };
  const usable = mine.filter((p) => p.unpriced !== true);
  if (usable.length === 0) return { ok: false, message: "DexScreener has a pair for this address but no price or liquidity yet" };
  const deepest = usable.reduce((a, b) => (b.liquidityUsd > a.liquidityUsd ? b : a));
  const created = deepest.pairCreatedAt !== undefined && Number.isFinite(deepest.pairCreatedAt) ? deepest.pairCreatedAt : undefined;
  return {
    ok: true,
    snapshot: {
      ca,
      name: deepest.name,
      symbol: deepest.symbol,
      marketCapUsd: deepest.marketCapUsd !== undefined && deepest.marketCapUsd > 0 ? deepest.marketCapUsd : null,
      liquidityUsd: deepest.liquidityUsd,
      pairCreatedAt: created !== undefined ? new Date(created).toISOString() : null,
      ageMinutes: created !== undefined ? Math.max(0, Math.floor((now.getTime() - created) / 60_000)) : null,
      // On the launchpad curve the pair's exchange is `pumpfun`; any other pool (pumpswap, raydium, ...) means the coin bonded.
      bonded: usable.some((p) => p.dexId !== undefined && p.dexId !== "pumpfun"),
    },
  };
}

/** The slice of the DexScreener client a lookup needs (tests pass a fake). */
export interface PickLookup {
  tokenPairs(chainId: string, addresses: string[]): Promise<DexPair[]>;
}

/** What the store must offer: the one write (`recordPick`, which refuses a repeat). */
export interface PickWriter {
  recordPick(input: { snapshot: PickSnapshot; reason: string; topic: string }, opts?: { now?: Date }): ResearchPick;
}

/** The outcome for one pasted line. `text` is what the Operator pasted, cleaned and cut, for display only. */
export type PickLineResult = { text: string; ok: true; pick: ResearchPick } | { text: string; ok: false; message: string };

/** The reason `recordPick` refuses a repeat inside 24 hours. */
export class PickRepeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PickRepeatError";
  }
}

/**
 * Looks up and records each pasted address on its own: a malformed, unknown or priceless address, a repeat inside 24 hours and a DexScreener failure
 * each give that line a plain message and record nothing for it; the other lines go on. One lookup per address, so one failure never hides the rest.
 */
export async function recordPicks(store: PickWriter, dex: PickLookup, input: { text: unknown; reason?: unknown; topic?: unknown }, opts: { now?: () => Date } = {}): Promise<{ lines: PickLineResult[]; skipped: number }> {
  const { cas, skipped } = splitCas(input.text);
  const reason = cleanReason(input.reason);
  const topic = cleanTopic(input.topic);
  const clock = opts.now ?? (() => new Date());
  const lines: PickLineResult[] = [];
  for (const ca of cas) {
    const text = cleanLine(ca, 50);
    if (!isCa(ca)) {
      lines.push({ text, ok: false, message: "Not a Solana contract address (32 to 44 letters and digits)" });
      continue;
    }
    let pairs: DexPair[];
    try {
      pairs = await dex.tokenPairs("solana", [ca]);
    } catch (e) {
      lines.push({ text, ok: false, message: `DexScreener could not be reached (${cleanLine(e instanceof Error ? e.message : String(e), 80)}); nothing recorded, try again` });
      continue;
    }
    const now = clock();
    const snap = snapshotFromPairs(ca, pairs, now);
    if (!snap.ok) {
      lines.push({ text, ok: false, message: snap.message });
      continue;
    }
    try {
      lines.push({ text, ok: true, pick: store.recordPick({ snapshot: snap.snapshot, reason, topic }, { now }) });
    } catch (e) {
      if (e instanceof PickRepeatError) lines.push({ text, ok: false, message: e.message });
      else throw e;
    }
  }
  return { lines, skipped };
}

/** Additive and idempotent. The update trigger makes a Pick unchangeable after it is written. */
export function migratePicks(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ca TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    market_cap_usd REAL,
    liquidity_usd REAL NOT NULL,
    pair_created_at TEXT,
    age_minutes INTEGER,
    bonded INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS picks_ca_at ON picks (ca, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS picks_at ON picks (created_at)");
  db.exec(`CREATE TRIGGER IF NOT EXISTS picks_immutable BEFORE UPDATE ON picks
    BEGIN SELECT RAISE(ABORT, 'a Pick is never changed'); END`);
}

type Row = Record<string, string | number | null>;

export function toPick(r: Row): ResearchPick {
  return {
    id: r.id as number,
    ca: r.ca as string,
    name: r.name as string,
    symbol: r.symbol as string,
    marketCapUsd: (r.market_cap_usd as number | null) ?? null,
    liquidityUsd: r.liquidity_usd as number,
    pairCreatedAt: (r.pair_created_at as string | null) ?? null,
    ageMinutes: (r.age_minutes as number | null) ?? null,
    bonded: r.bonded === 1,
    reason: r.reason as string,
    topic: r.topic as string,
    createdAt: r.created_at as string,
  };
}
