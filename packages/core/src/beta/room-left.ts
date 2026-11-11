import type { MetaCounts, MetaRow, MetaRun } from "../meta/store.ts";

/**
 * Room-left ranking (viral sources ticket 04, slice 1): which of the stored Metas (ticket 03) still has room for one more token, rather
 * than which is biggest. Plain code over a stored run, no LLM, no I/O, no clock: the run's own `computedAt` is "now", so the same run
 * always gives the same answer and a replay at a past time sees only what was stored then.
 *
 * The rule is a gate plus an order, not a score with magic weights:
 *   Gates (a Meta that fails any is not offered; the first gate it fails is named): not young, evidence, lead, fading, saturated.
 *   Order among those that pass: migration lift over the run's base rate, then momentum (the 6 h share of the 24 h count), then the lead
 *   token's market cap, then distinct creators; the group key breaks the last tie so input order never matters.
 *
 * Why not size: on 2026-11-11 the size order (ni hao 310 creates, Dacity 228, GTA VI 153, DeepSeek 11) is nearly the opposite of the
 * room-left order (DeepSeek 10 of 11 migrated, GTA VI 31 of 153, ni hao 15 of 310; Dacity 1 of 228 is removed as saturated).
 *
 * Migrations are unfiltered (the bot filter, Phase 3 ticket 04, is not built) and about a third of them are bundled with the create.
 * The base rate is unfiltered too, so a group whose migrations are mostly bundled is measured on `migrationsAfter60s` instead: that
 * numerator is smaller, so the choice is conservative, never flattering.
 */

export interface RoomLeftRule {
  /**
   * The lead token's market cap (USD) must be at least this. `null` switches the gate off (the backtest has no historical market cap).
   * With the gate on, a Meta with no market cap figure fails it: a running lead is the point.
   */
  minLeadMarketCapUsd: number | null;
  /** Distinct creators in 24 h, at least. */
  minCreators: number;
  /** Saturated when creates per migration exceed this many times the base creates per migration (1 / base rate), or nothing migrated. */
  saturationFactor: number;
  /** Fading when the 6 h token count is below this fraction of the 24 h count. */
  minRecentShare: number;
  /** A Meta first seen less than this many minutes before the run is still forming its lead. */
  minAgeMinutes: number;
  /** When at least this share of a group's migrations were bundled with the create (within 60 s), lift is measured on `migrationsAfter60s`. */
  bundledShareHigh: number;
  /**
   * At least this many migrations in 24 h (on the lift's basis), as a further evidence gate. 0 is off, the ticket's rule: the lead-cap
   * floor is what keeps one migration out of six (a lift of 6x) from ranking, and the backtest has no historical market cap, so it
   * can switch this on to stand in for it.
   */
  minMigrations: number;
}

export const ROOM_LEFT_RULE: RoomLeftRule = {
  minLeadMarketCapUsd: 1_000_000,
  minCreators: 5,
  saturationFactor: 3,
  minRecentShare: 0.25,
  minAgeMinutes: 30,
  bundledShareHigh: 0.5,
  minMigrations: 0,
};

export type RoomLeftGate = "young" | "evidence" | "lead" | "fading" | "saturated" | "no-base-rate";

export interface RoomLeftCandidate {
  row: MetaRow;
  /** Group migration rate over the run's base rate. */
  lift: number;
  /** Which migration count the lift used. */
  liftBasis: "unfiltered" | "after-60s";
  /** Tokens created in the last 6 h as a share of the 24 h count. */
  momentum: number;
  /** One line per term that decided the order, plain text built from numbers only. */
  reasons: string[];
}

export interface RoomLeftRejection {
  row: MetaRow;
  gate: RoomLeftGate;
  /** Plain text built from numbers only (the row's label is not in it). */
  reason: string;
}

export interface RoomLeftRanking {
  computedAt: string;
  baseMigrationRate: number | null;
  /** Best first. */
  candidates: RoomLeftCandidate[];
  rejected: RoomLeftRejection[];
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function gateOf(row: MetaRow, base: number, asOfMs: number, rule: RoomLeftRule): RoomLeftRejection | undefined {
  const day = row.counts["24h"];
  const six = row.counts["6h"];
  const reject = (gate: RoomLeftGate, reason: string): RoomLeftRejection => ({ row, gate, reason });

  const ageMin = (asOfMs - Date.parse(row.firstSeenAt)) / 60_000;
  if (!(ageMin >= rule.minAgeMinutes)) return reject("young", `first seen ${Math.max(0, Math.round(ageMin))} min ago, under ${rule.minAgeMinutes}: its lead is still forming`);
  if (day.creators < rule.minCreators) return reject("evidence", `${day.creators} distinct creators in 24 h, under ${rule.minCreators}`);
  const basis = liftBasisOf(day, rule);
  const counted = basis === "after-60s" ? day.migrationsAfter60s : day.migrations;
  if (counted < rule.minMigrations) return reject("evidence", `migrations ${basis === "after-60s" ? "after 60 s " : ""}in 24 h: ${counted}, under ${rule.minMigrations}`);
  if (rule.minLeadMarketCapUsd !== null) {
    if (row.topMarketCapUsd === undefined) return reject("lead", "no market cap for any token: no running lead is shown");
    if (row.topMarketCapUsd < rule.minLeadMarketCapUsd) return reject("lead", `lead market cap ${usd(row.topMarketCapUsd)}, under ${usd(rule.minLeadMarketCapUsd)}`);
  }
  if (day.tokens > 0 && six.tokens < rule.minRecentShare * day.tokens) {
    return reject("fading", `${six.tokens} tokens in the last 6 h of ${day.tokens} in 24 h (${pct(six.tokens / day.tokens)}), under ${pct(rule.minRecentShare)}`);
  }
  const ceiling = rule.saturationFactor / base;
  if (day.migrations === 0) return reject("saturated", `${day.tokens} creates in 24 h and none migrated`);
  const perMigration = day.tokens / day.migrations;
  if (perMigration > ceiling) return reject("saturated", `${Math.round(perMigration)} creates per migration, over ${Math.round(ceiling)} (${rule.saturationFactor}x the base ${Math.round(1 / base)})`);
  return undefined;
}

function liftBasisOf(day: MetaCounts, rule: RoomLeftRule): "unfiltered" | "after-60s" {
  const bundledShare = day.migrations > 0 ? 1 - day.migrationsAfter60s / day.migrations : 0;
  return bundledShare >= rule.bundledShareHigh ? "after-60s" : "unfiltered";
}

function candidateOf(row: MetaRow, base: number, rule: RoomLeftRule): RoomLeftCandidate {
  const day = row.counts["24h"];
  const liftBasis = liftBasisOf(day, rule);
  const migrations = liftBasis === "after-60s" ? day.migrationsAfter60s : day.migrations;
  const rate = day.tokens > 0 ? migrations / day.tokens : 0;
  const lift = rate / base;
  const momentum = day.tokens > 0 ? row.counts["6h"].tokens / day.tokens : 0;
  const reasons = [
    `lift ${lift.toFixed(1)}x base (${pct(rate)} of ${day.tokens} creates migrated vs ${pct(base)} overall, ${liftBasis})`,
    `momentum ${pct(momentum)} of the 24 h creates came in the last 6 h`,
    ...(row.topMarketCapUsd !== undefined ? [`lead market cap ${usd(row.topMarketCapUsd)}`] : []),
    `${day.creators} distinct creators`,
  ];
  return { row, lift, liftBasis, momentum, reasons };
}

function compareCandidates(a: RoomLeftCandidate, b: RoomLeftCandidate): number {
  if (a.lift !== b.lift) return b.lift - a.lift;
  if (a.momentum !== b.momentum) return b.momentum - a.momentum;
  const x = a.row.topMarketCapUsd;
  const y = b.row.topMarketCapUsd;
  if (x !== y) return x === undefined ? 1 : y === undefined ? -1 : y - x;
  if (a.row.counts["24h"].creators !== b.row.counts["24h"].creators) return b.row.counts["24h"].creators - a.row.counts["24h"].creators;
  return cmpStr(a.row.key, b.row.key);
}

/**
 * Ranks a stored 24 h Meta run by room left. The run must be the 24 h one (its base rate is the 24 h base); each row carries both
 * windows' counts. `candidates` is every Meta that passed the gates, best first; the caller takes as many as it wants.
 */
export function rankRoomLeft(run: MetaRun, rule: RoomLeftRule = ROOM_LEFT_RULE): RoomLeftRanking {
  if (run.window !== "24h") throw new RangeError(`rankRoomLeft needs the 24 h run, got ${run.window}`);
  const base = run.baseMigrationRate;
  const asOfMs = Date.parse(run.computedAt);
  const candidates: RoomLeftCandidate[] = [];
  const rejected: RoomLeftRejection[] = [];
  for (const row of run.rows) {
    if (base === null || !(base > 0)) {
      rejected.push({ row, gate: "no-base-rate", reason: "no base migration rate in this run (nothing created or nothing migrated), so there is nothing to compare against" });
      continue;
    }
    const out = gateOf(row, base, asOfMs, rule);
    if (out) rejected.push(out);
    else candidates.push(candidateOf(row, base, rule));
  }
  candidates.sort(compareCandidates);
  rejected.sort((a, b) => cmpStr(a.row.key, b.row.key));
  return { computedAt: run.computedAt, baseMigrationRate: base, candidates, rejected };
}
