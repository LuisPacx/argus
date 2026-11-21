import type { DatabaseSync } from "node:sqlite";
import type { DexPair } from "../sources/dexscreener.ts";
import { decideBonded, LAUNCHPAD_MINT_SUFFIX, toPick, type PickLookup, type PickSource, type ResearchPick } from "./picks.ts";

/**
 * Pick outcomes (human researcher ticket 04): what became of each Pick, from plain code only (no Claude, no Brain). A scheduled job looks the coin
 * up on DexScreener and records (a) whether it bonded within 24 hours of the Pick, and (b) the peak market cap seen up to +1h, +6h and +24h.
 * DexScreener gives current values only, so a mark is sampled by a lookup made in the short grace window after its time; a mark nobody looked at
 * in that window (the worker was down, the lookup failed) is stored as `missed`, never filled in later. The picks table stays immutable: outcomes
 * live in `pick_outcomes` (one row per Pick) and `pick_samples` (one row per mark), both keyed on the Pick id.
 */

export const OUTCOME_MARKS = [
  { key: "1h", hours: 1 },
  { key: "6h", hours: 6 },
  { key: "24h", hours: 24 },
] as const;
export type MarkKey = (typeof OUTCOME_MARKS)[number]["key"];
const HOUR_MS = 3_600_000;
/** The bonding window and the third mark. */
export const OUTCOME_WINDOW_MS = 24 * HOUR_MS;
/** A mark can be sampled from its time to this long after it; later it is `missed`. Four ticks at the 5-minute schedule. */
export const SAMPLE_GRACE_MS = 20 * 60_000;
/** A Pick still undecided this long after its 24 hours ended (lookups kept failing) ends `unknown`. */
export const OUTCOME_GIVE_UP_MS = 2 * OUTCOME_WINDOW_MS;
/** How often the worker runs the job. Marks are timed from each Pick's own `created_at`, so a restart loses nothing but the ticks it was down for. */
export const OUTCOME_TICK_MS = 5 * 60_000;
/** DexScreener's token lookup takes at most this many addresses a request. */
const LOOKUP_BATCH = 30;
/** A decision from what DexScreener shows after the deadline waits this long, so a pool opened in the last minutes is indexed by then. */
export const BOND_SETTLE_MS = 10 * 60_000;
export const OUTCOME_WEEK_MS = 7 * 24 * HOUR_MS;

/** `pending` until decided; `already-bonded` when the coin had bonded before the Pick (never counted in the rate); `unknown` when the coin vanished or could not be checked. */
export type OutcomeResult = "pending" | "bonded" | "not-bonded" | "unknown" | "already-bonded";
export type SampleState = "sampled" | "missed";

export interface OutcomeSample {
  mark: MarkKey;
  state: SampleState;
  /** The highest market cap (USD) seen from the Pick up to this mark; null for a missed mark. */
  peakUsd: number | null;
  takenAt: string;
}

export interface OutcomeState {
  result: OutcomeResult;
  /** When the coin bonded (the Study's migration time, or the lookup time that first showed it), for `bonded`. */
  bondedAt: string | null;
  bondedBasis: string;
  /** The running peak market cap seen so far (starts at the Pick's own snapshot). */
  peakUsd: number | null;
  lastOkAt: string | null;
  /** Set when the result is decided and every mark is sampled or missed; the job never looks at the Pick again. */
  finishedAt: string | null;
}

export interface OpenPick {
  pick: ResearchPick;
  outcome: OutcomeState | null;
  samples: OutcomeSample[];
}

/** What the job needs from the store (tests pass the real in-memory Datastore). */
export interface OutcomeStore {
  openPickOutcomes(): OpenPick[];
  applyPickProgress(pickId: number, progress: { outcome: OutcomeState; samples: OutcomeSample[] }): void;
  migrationOf(mint: string): string | null;
}

export interface OutcomeTickReport {
  open: number;
  /** Picks whose coin could not be looked up this tick (retried on the next one). */
  failed: number;
  sampled: number;
  missed: number;
  decided: number;
  finished: number;
}

const maxOf = (...xs: (number | null | undefined)[]): number | null => {
  const ok = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return ok.length === 0 ? null : Math.max(...ok);
};

/**
 * One Pick, one tick: the new state given the coin's pairs from a lookup that worked (`pairs`), or `undefined` when the lookup failed (nothing is
 * decided from a failure). A change to nothing returns null. Pure; `migratedAt` is Argus's own record of the mint migrating.
 */
export function advancePick(o: OpenPick, pairs: readonly DexPair[] | undefined, migratedAt: string | null, nowMs: number): { outcome: OutcomeState; samples: OutcomeSample[] } | null {
  const p = o.pick;
  const created = Date.parse(p.createdAt);
  const deadline = created + OUTCOME_WINDOW_MS;
  const nowIso = new Date(nowMs).toISOString();
  const prev = o.outcome;
  const st: OutcomeState = { result: prev?.result ?? "pending", bondedAt: prev?.bondedAt ?? null, bondedBasis: prev?.bondedBasis ?? "", peakUsd: prev?.peakUsd ?? null, lastOkAt: prev?.lastOkAt ?? null, finishedAt: null };
  const have = new Set(o.samples.map((s) => s.mark));
  const samples: OutcomeSample[] = [];
  let changed = false;

  // Argus's own migration record decides without any lookup (so DexScreener being down never loses it): before the Pick it was already bonded,
  // inside the 24 hours it bonded, after them it did not.
  if (st.result === "pending") {
    const m = migratedAt !== null ? Date.parse(migratedAt) : null;
    if (p.bondedAtPick || (m !== null && m <= created)) st.result = "already-bonded";
    else if (m !== null && m <= deadline) Object.assign(st, { result: "bonded", bondedAt: migratedAt, bondedBasis: "argus-migration" });
    else if (m !== null && nowMs >= deadline) st.result = "not-bonded";
  }

  if (pairs !== undefined) {
    changed = true;
    const usable = pairs.filter((x) => x.tokenAddress === p.ca && x.unpriced !== true);
    const deepest = usable.reduce<DexPair | undefined>((a, b) => (a === undefined || b.liquidityUsd > a.liquidityUsd ? b : a), undefined);
    const mc = deepest?.marketCapUsd !== undefined && deepest.marketCapUsd > 0 ? deepest.marketCapUsd : null;
    st.peakUsd = maxOf(st.peakUsd, p.marketCapUsd, mc);
    // An empty answer is "the coin was not there", not "seen": it never counts as a sighting.
    if (usable.length > 0) st.lastOkAt = nowIso;
    if (st.result === "pending") {
      const d = decideBonded(p.ca, usable, null);
      if (d.bonded) {
        // No record of when it bonded: inside the window the sighting is the time; after it, the coin may have bonded before or after the deadline, which
        // cannot be told, so it is unknown (left out of the rate) rather than guessed either way.
        if (nowMs <= deadline) Object.assign(st, { result: "bonded", bondedAt: nowIso, bondedBasis: d.basis });
        else if (nowMs >= deadline + BOND_SETTLE_MS) st.result = "unknown";
      } else if (nowMs >= deadline + BOND_SETTLE_MS) {
        // Bonding never undoes, so a coin clearly still on the curve a little after the deadline did not bond within the window (the settle lets
        // DexScreener index a pool opened in the last minutes). Clearly: it has a pair, and a launchpad mint shows its curve pair. Anything else waits.
        const onCurve = usable.some((x) => x.dexId === "pumpfun");
        if (usable.length > 0 && (onCurve || !p.ca.endsWith(LAUNCHPAD_MINT_SUFFIX))) st.result = "not-bonded";
        else if (usable.length === 0) st.result = "unknown"; // a complete answer with no pair for the coin: it vanished
      }
    }
    for (const { key, hours } of OUTCOME_MARKS) {
      const due = created + hours * HOUR_MS;
      if (!have.has(key) && nowMs >= due && nowMs <= due + SAMPLE_GRACE_MS && mc !== null) samples.push({ mark: key, state: "sampled", peakUsd: st.peakUsd, takenAt: nowIso });
    }
  }
  for (const { key, hours } of OUTCOME_MARKS) {
    if (!have.has(key) && !samples.some((s) => s.mark === key) && nowMs > created + hours * HOUR_MS + SAMPLE_GRACE_MS) samples.push({ mark: key, state: "missed", peakUsd: null, takenAt: nowIso });
  }
  if (samples.length > 0) changed = true;
  if (st.result === "pending" && nowMs >= created + OUTCOME_GIVE_UP_MS) {
    st.result = "unknown";
    changed = true;
  }
  if (st.result !== "pending" && have.size + samples.length === OUTCOME_MARKS.length) {
    st.finishedAt = nowIso;
    changed = true;
  }
  if (st.result !== (prev?.result ?? "pending")) changed = true;
  return changed ? { outcome: st, samples } : null;
}

/** One pass over the unfinished Picks: one DexScreener lookup per 30 coins, then each Pick moves on by its own clock. A failed lookup decides nothing. */
export async function trackPickOutcomes(store: OutcomeStore, dex: PickLookup, opts: { now?: () => Date } = {}): Promise<OutcomeTickReport> {
  const open = store.openPickOutcomes();
  const report: OutcomeTickReport = { open: open.length, failed: 0, sampled: 0, missed: 0, decided: 0, finished: 0 };
  const answers = new Map<string, DexPair[]>();
  const cas = [...new Set(open.map((o) => o.pick.ca))];
  // A batch the client says may be cut (or that fails for any reason) is split in half and each half asked again; a single coin whose answer
  // still fails is retried next tick. So a cut answer never decides a coin: only complete answers reach `answers`.
  const lookup = async (chunk: string[]): Promise<void> => {
    try {
      const pairs = await dex.tokenPairs("solana", chunk, { failIfTruncated: true });
      for (const ca of chunk) answers.set(ca, pairs.filter((x) => x.tokenAddress === ca));
    } catch {
      if (chunk.length === 1) return;
      const mid = Math.ceil(chunk.length / 2);
      await lookup(chunk.slice(0, mid));
      await lookup(chunk.slice(mid));
    }
  };
  for (let i = 0; i < cas.length; i += LOOKUP_BATCH) await lookup(cas.slice(i, i + LOOKUP_BATCH));
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  for (const o of open) {
    const pairs = answers.get(o.pick.ca);
    if (pairs === undefined) report.failed += 1;
    const next = advancePick(o, pairs, store.migrationOf(o.pick.ca), nowMs);
    if (next === null) continue;
    store.applyPickProgress(o.pick.id, next);
    report.sampled += next.samples.filter((s) => s.state === "sampled").length;
    report.missed += next.samples.filter((s) => s.state === "missed").length;
    if ((o.outcome?.result ?? "pending") === "pending" && next.outcome.result !== "pending") report.decided += 1;
    if (next.outcome.finishedAt !== null) report.finished += 1;
  }
  return report;
}

/** Additive and idempotent. */
export function migratePickOutcomes(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pick_outcomes (
    pick_id INTEGER PRIMARY KEY,
    result TEXT NOT NULL DEFAULT 'pending',
    bonded_at TEXT,
    bonded_basis TEXT NOT NULL DEFAULT '',
    peak_usd REAL,
    last_ok_at TEXT,
    finished_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS pick_samples (
    pick_id INTEGER NOT NULL,
    mark TEXT NOT NULL,
    state TEXT NOT NULL,
    peak_usd REAL,
    taken_at TEXT NOT NULL,
    PRIMARY KEY (pick_id, mark)
  )`);
}

type Row = Record<string, string | number | null>;

const toOutcome = (r: Row): OutcomeState => ({ result: r.result as OutcomeResult, bondedAt: (r.bonded_at as string | null) ?? null, bondedBasis: r.bonded_basis as string, peakUsd: (r.peak_usd as number | null) ?? null, lastOkAt: (r.last_ok_at as string | null) ?? null, finishedAt: (r.finished_at as string | null) ?? null });
const toSample = (r: Row): OutcomeSample => ({ mark: r.mark as MarkKey, state: r.state as SampleState, peakUsd: (r.peak_usd as number | null) ?? null, takenAt: r.taken_at as string });

/** Every Pick (any source) whose outcome is not finished, oldest first, with what is stored so far. Reads the picks table directly: no list cap. */
export function loadOpenPicks(db: DatabaseSync): OpenPick[] {
  const rows = db.prepare("SELECT p.*, o.result AS o_result, o.bonded_at AS o_bonded_at, o.bonded_basis AS o_bonded_basis, o.peak_usd AS o_peak_usd, o.last_ok_at AS o_last_ok_at FROM picks p LEFT JOIN pick_outcomes o ON o.pick_id = p.id WHERE o.finished_at IS NULL ORDER BY p.id").all() as Row[];
  const samples = db.prepare("SELECT * FROM pick_samples WHERE pick_id IN (SELECT p.id FROM picks p LEFT JOIN pick_outcomes o ON o.pick_id = p.id WHERE o.finished_at IS NULL)").all() as Row[];
  return rows.map((r) => ({
    pick: toPick(r),
    outcome: typeof r.o_result !== "string" ? null : toOutcome({ result: r.o_result,bonded_at: r.o_bonded_at ?? null, bonded_basis: r.o_bonded_basis ?? "", peak_usd: r.o_peak_usd ?? null, last_ok_at: r.o_last_ok_at ?? null, finished_at: null }),
    samples: samples.filter((s) => s.pick_id === r.id).map(toSample),
  }));
}

/** Writes the Pick's whole outcome row and any new samples. A sample already stored is never replaced. */
export function saveProgress(db: DatabaseSync, pickId: number, progress: { outcome: OutcomeState; samples: OutcomeSample[] }): void {
  const o = progress.outcome;
  db.prepare("INSERT INTO pick_outcomes (pick_id, result, bonded_at, bonded_basis, peak_usd, last_ok_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pick_id) DO UPDATE SET result = excluded.result, bonded_at = excluded.bonded_at, bonded_basis = excluded.bonded_basis, peak_usd = excluded.peak_usd, last_ok_at = excluded.last_ok_at, finished_at = excluded.finished_at").run(pickId, o.result, o.bondedAt, o.bondedBasis, o.peakUsd, o.lastOkAt, o.finishedAt);
  for (const s of progress.samples) db.prepare("INSERT OR IGNORE INTO pick_samples (pick_id, mark, state, peak_usd, taken_at) VALUES (?, ?, ?, ?, ?)").run(pickId, s.mark, s.state, s.peakUsd, s.takenAt);
}

/** One Pick's outcome as the page shows it. `over` is true once the Pick's 24 hours are over. */
export interface PickOutcome {
  pickId: number;
  result: OutcomeResult;
  over: boolean;
  bondedAt: string | null;
  /** One entry per mark, in order: `waiting` until it is sampled or missed. */
  marks: { mark: MarkKey; state: SampleState | "waiting"; peakUsd: number | null }[];
}

/** The bonding rate over a set of Picks: `bonded / finished`, with the Picks left out counted beside it. `rate` is null when `finished` is 0. */
export interface BondingStats {
  bonded: number;
  finished: number;
  rate: number | null;
  /** Bonded already at the Pick: left out of the rate. */
  alreadyBonded: number;
  /** Coin vanished or could not be checked: left out of the rate. */
  unknown: number;
  /** Picks whose 24 hours are not over, or whose outcome is not decided yet. */
  pending: number;
}

export interface PickOutcomeView {
  outcomes: PickOutcome[];
  all: BondingStats;
  week: BondingStats;
}

export function bondingStats(items: readonly { over: boolean; result: OutcomeResult }[]): BondingStats {
  const s: BondingStats = { bonded: 0, finished: 0, rate: null, alreadyBonded: 0, unknown: 0, pending: 0 };
  for (const i of items) {
    if (i.result === "already-bonded") s.alreadyBonded += 1;
    else if (i.result === "unknown") s.unknown += 1;
    else if (!i.over || i.result === "pending") s.pending += 1;
    else {
      s.finished += 1;
      if (i.result === "bonded") s.bonded += 1;
    }
  }
  s.rate = s.finished === 0 ? null : s.bonded / s.finished;
  return s;
}

/** All Picks of one source read directly (no cap) for the rate; the outcome rows for the `limit` newest. READ ONLY. */
export function loadOutcomeView(db: DatabaseSync, source: PickSource, now: Date, limit: number): PickOutcomeView {
  const rows = db.prepare("SELECT p.id, p.created_at, p.bonded_at_pick, o.result AS o_result, o.bonded_at AS o_bonded_at FROM picks p LEFT JOIN pick_outcomes o ON o.pick_id = p.id WHERE p.source = ? ORDER BY p.id DESC").all(source) as Row[];
  const nowMs = now.getTime();
  const items = rows.map((r) => {
    const createdMs = Date.parse(r.created_at as string);
    const result: OutcomeResult = (r.o_result as OutcomeResult | null) ?? (r.bonded_at_pick === 1 ? "already-bonded" : "pending");
    return { id: r.id as number, createdMs, over: nowMs >= createdMs + OUTCOME_WINDOW_MS, result, bondedAt: (r.o_bonded_at as string | null) ?? null };
  });
  const newest = items.slice(0, limit);
  const samples = newest.length === 0 ? [] : (db.prepare(`SELECT * FROM pick_samples WHERE pick_id IN (${newest.map(() => "?").join(",")})`).all(...newest.map((i) => i.id)) as Row[]);
  return {
    outcomes: newest.map((i) => ({
      pickId: i.id,
      result: i.result,
      over: i.over,
      bondedAt: i.bondedAt,
      marks: OUTCOME_MARKS.map(({ key }) => {
        const s = samples.find((x) => x.pick_id === i.id && x.mark === key);
        return { mark: key, state: s ? (s.state as SampleState) : ("waiting" as const), peakUsd: s ? ((s.peak_usd as number | null) ?? null) : null };
      }),
    })),
    all: bondingStats(items),
    week: bondingStats(items.filter((i) => nowMs - i.createdMs <= OUTCOME_WEEK_MS)),
  };
}
