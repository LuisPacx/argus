import type { Datastore } from "../datastore.ts";
import { META_RULE, type MetaConfig } from "../meta/config.ts";
import { recomputeMetas } from "../meta/compute.ts";
import { groupTokens } from "../meta/group.ts";
import { isGenericKey } from "../meta/group.ts";
import { subjectKey } from "../meta/key.ts";
import { MAX_META_READ, type MetaRow } from "../meta/store.ts";
import type { LaunchedToken } from "../study/store.ts";
import { checkDistinctName, type ExistingToken } from "./distinct-name.ts";
import { rankRoomLeft, ROOM_LEFT_RULE, type RoomLeftRanking, type RoomLeftRule } from "./room-left.ts";
import { clusterBootstrapDiff, newcombeDiff, wilson, type Cluster, type Interval } from "./stats.ts";

/**
 * The Beta backtest (viral sources ticket 04, slice 5). Question: if argus had offered a Beta for the top room-left Metas at hour T, did
 * the tokens that then joined those Metas migrate more often than the market as a whole, and than the Metas a size ranking would have
 * picked? Offline, on a COPY of the database; the script `scripts/backtest-beta.mjs` is the opt-in front end.
 *
 * No look-ahead: the ranking at T is `recomputeMetas({ now: T })`, which reads only creates at or before T and counts only migrations at
 * or before T (tested). The outcome is read after T by design: tokens created in (T, T + H] whose subject key belongs to the Meta's
 * group at T and whose creator had no token in that group before T (the closest stand-in for "a Beta launched at T"), and whether each
 * migrated by T + H, unfiltered and more than 60 s after its own create.
 *
 * Market cap is NOT available as of T (DexScreener answers for now), so the backtest runs without it and the lead-cap gate is switched
 * off (`rule.minLeadMarketCapUsd = null`). It tests the other gates and the order, not the cap floor.
 *
 * The write this does: `recomputeMetas` stores a Meta run per T. That is why it only ever runs on a copy.
 */

export interface BacktestOptions {
  /** The hours T to evaluate, any order. */
  times: Date[];
  /** The newest time the data covers; a T whose horizon runs past it is skipped for that horizon. */
  dataEnd: Date;
  /** Metas per arm (the pass offers at most 3). */
  top: number;
  horizonsHours: number[];
  rule: RoomLeftRule;
  metaConfig: MetaConfig;
  bootstrapResamples?: number;
}

export const DEFAULT_BACKTEST: Pick<BacktestOptions, "top" | "horizonsHours" | "rule" | "metaConfig"> = {
  top: 3,
  horizonsHours: [6, 24],
  rule: { ...ROOM_LEFT_RULE, minLeadMarketCapUsd: null },
  metaConfig: { ...META_RULE, dexGroups: 0, dexMaxCalls: 0, maxRowsPerWindow: MAX_META_READ },
};

export const ARMS = ["roomLeft", "size", "rejected"] as const;
export type ArmName = (typeof ARMS)[number] | "base";

export interface ArmCounts {
  /** Distinct tokens (a token seen from several T counts once). */
  tokens: number;
  /** Migrated by the end of the horizon, unfiltered. */
  migrated: number;
  /** Of those, migrated more than 60 s after the token's own create. */
  migratedAfter60s: number;
  /** Distinct Metas (group keys) that contributed. */
  metas: number;
  /** Snapshots in which the arm had at least one token. */
  snapshots: number;
}

export interface HorizonResult {
  horizonHours: number;
  /** Snapshots whose horizon fits inside the data. */
  snapshots: number;
  arms: Record<ArmName, ArmCounts>;
  /** One Cluster per contributing Meta, for the cluster bootstrap. */
  clusters: Record<(typeof ARMS)[number], { unfiltered: Cluster[]; after60: Cluster[] }>;
  /** Of the room-left joiners, how many names slice 2 would have rejected as copies of a token in the Meta at T. */
  copies: { checked: number; rejected: number };
}

export interface BacktestReport {
  from: string;
  to: string;
  dataEnd: string;
  stepMinutes: number;
  top: number;
  snapshots: number;
  rule: RoomLeftRule;
  horizons: HorizonResult[];
}

interface GroupInfo {
  creators: Set<string>;
  tokens: ExistingToken[];
}

export interface Snapshot {
  t: Date;
  ranking: RoomLeftRanking;
  /** The Metas a size ranking would have picked, biggest 24 h token count first. */
  sizeTop: MetaRow[];
  /** Group key to what was in it at T, for the Metas in the run. */
  groups: Map<string, GroupInfo>;
  /** Non-generic subject key to the group key it belonged to at T. */
  keyIndex: Map<string, string>;
}

const HOUR_MS = 3_600_000;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The Meta ranking and room-left ranking as they stood at `t`, from rows at or before it. Writes a Meta run into `store` (use a copy). */
export async function snapshotAt(store: Datastore, t: Date, opts: Pick<BacktestOptions, "rule" | "metaConfig">): Promise<Snapshot> {
  const result = await recomputeMetas(store, { now: t, config: opts.metaConfig });
  const run = store.latestMetas("24h", MAX_META_READ);
  if (!run || run.id !== result.runId) throw new Error(`the run just stored for ${t.toISOString()} is not the newest run in the database`);
  const ranking = rankRoomLeft(run, opts.rule);
  const sizeTop = [...run.rows].sort((a, b) => b.counts["24h"].tokens - a.counts["24h"].tokens || cmpStr(a.key, b.key));

  const wanted = new Set(run.rows.map((r) => r.key));
  const groups = new Map<string, GroupInfo>();
  const keyIndex = new Map<string, string>();
  const tokens = store.study.createdBetween(new Date(t.getTime() - 24 * HOUR_MS).toISOString(), t.toISOString());
  for (const g of groupTokens(tokens)) {
    if (!wanted.has(g.key)) continue;
    groups.set(g.key, { creators: new Set(g.tokens.map((x) => x.creator)), tokens: g.tokens.map((x) => ({ name: x.name, symbol: x.symbol })) });
    for (const x of g.tokens) for (const k of subjectKey(x.name, x.symbol)) if (!isGenericKey(k)) keyIndex.set(k, g.key);
  }
  return { t, ranking, sizeTop, groups, keyIndex };
}

interface Tok {
  token: LaunchedToken;
  createdMs: number;
  migratedMs: number | null;
  keys: string[];
}

interface Acc {
  /** mint -> outcome (from the latest snapshot that saw it), the Meta group it joined. */
  seen: Map<string, { group: string; migrated: boolean; after60: boolean }>;
  metas: Set<string>;
  snapshots: number;
}

const newAcc = (): Acc => ({ seen: new Map(), metas: new Set(), snapshots: 0 });

function counts(acc: Acc): ArmCounts {
  let migrated = 0;
  let after = 0;
  for (const v of acc.seen.values()) {
    if (v.migrated) migrated++;
    if (v.after60) after++;
  }
  return { tokens: acc.seen.size, migrated, migratedAfter60s: after, metas: acc.metas.size, snapshots: acc.snapshots };
}

function clustersOf(acc: Acc, pick: "migrated" | "after60"): Cluster[] {
  const by = new Map<string, Cluster>();
  for (const v of acc.seen.values()) {
    const c = by.get(v.group) ?? { k: 0, n: 0 };
    c.n++;
    if (v[pick === "migrated" ? "migrated" : "after60"]) c.k++;
    by.set(v.group, c);
  }
  return [...by.values()];
}

export async function runBacktest(store: Datastore, opts: BacktestOptions): Promise<BacktestReport> {
  const times = [...opts.times].sort((a, b) => a.getTime() - b.getTime());
  if (times.length === 0) throw new RangeError("the backtest needs at least one time");
  const maxH = Math.max(...opts.horizonsHours);
  const first = times[0] as Date;
  const last = times[times.length - 1] as Date;
  const loaded = store.study.createdBetween(first.toISOString(), new Date(Math.min(opts.dataEnd.getTime(), last.getTime() + maxH * HOUR_MS)).toISOString());
  const all: Tok[] = loaded
    .map((token) => ({
      token,
      createdMs: Date.parse(token.createdAt),
      migratedMs: token.migratedAt !== null ? Date.parse(token.migratedAt) : null,
      keys: subjectKey(token.name, token.symbol).filter((k) => !isGenericKey(k)),
    }))
    .sort((a, b) => a.createdMs - b.createdMs);

  const perHorizon = new Map(
    opts.horizonsHours.map((h) => [h, { snapshots: 0, accs: { roomLeft: newAcc(), size: newAcc(), rejected: newAcc(), base: newAcc() } as Record<ArmName, Acc>, copies: { checked: 0, rejected: 0 }, copySeen: new Set<string>() }]),
  );

  for (const t of times) {
    const tMs = t.getTime();
    const snap = await snapshotAt(store, t, opts);
    // The arms overlap: a Meta can be in the size top and be one the gates rejected.
    const members: Record<(typeof ARMS)[number], Set<string>> = {
      roomLeft: new Set(snap.ranking.candidates.slice(0, opts.top).map((c) => c.row.key)),
      size: new Set(snap.sizeTop.slice(0, opts.top).map((r) => r.key)),
      rejected: new Set(snap.ranking.rejected.map((r) => r.row.key)),
    };
    for (const h of opts.horizonsHours) {
      const endMs = tMs + h * HOUR_MS;
      if (endMs > opts.dataEnd.getTime()) continue;
      const out = perHorizon.get(h)!;
      out.snapshots++;
      const touched = new Set<ArmName>();
      for (const f of all) {
        if (f.createdMs <= tMs) continue;
        if (f.createdMs > endMs) break;
        const migrated = f.migratedMs !== null && f.migratedMs <= endMs;
        const outcome = { migrated, after60: migrated && (f.migratedMs as number) - f.createdMs > 60_000 };
        out.accs.base.seen.set(f.token.mint, { group: "", ...outcome });
        touched.add("base");
        const g = f.keys.map((k) => snap.keyIndex.get(k)).find((x) => x !== undefined);
        if (g === undefined || snap.groups.get(g)?.creators.has(f.token.creator)) continue;
        for (const kind of ARMS) {
          if (!members[kind].has(g)) continue;
          const acc = out.accs[kind];
          acc.seen.set(f.token.mint, { group: g, ...outcome });
          acc.metas.add(g);
          touched.add(kind);
          if (kind === "roomLeft" && !out.copySeen.has(f.token.mint)) {
            out.copySeen.add(f.token.mint);
            out.copies.checked++;
            if (!checkDistinctName({ name: f.token.name, ticker: f.token.symbol }, snap.groups.get(g)!.tokens).ok) out.copies.rejected++;
          }
        }
      }
      for (const k of touched) out.accs[k].snapshots++;
    }
  }

  const horizons: HorizonResult[] = opts.horizonsHours.map((h) => {
    const o = perHorizon.get(h)!;
    const cl = (name: (typeof ARMS)[number]) => ({ unfiltered: clustersOf(o.accs[name], "migrated"), after60: clustersOf(o.accs[name], "after60") });
    return {
      horizonHours: h,
      snapshots: o.snapshots,
      arms: { roomLeft: counts(o.accs.roomLeft), size: counts(o.accs.size), rejected: counts(o.accs.rejected), base: counts(o.accs.base) },
      clusters: { roomLeft: cl("roomLeft"), size: cl("size"), rejected: cl("rejected") },
      copies: o.copies,
    };
  });
  const step = times.length > 1 ? Math.round(((last.getTime() - first.getTime()) / (times.length - 1)) / 60_000) : 0;
  return { from: first.toISOString(), to: last.toISOString(), dataEnd: opts.dataEnd.toISOString(), stepMinutes: step, top: opts.top, snapshots: times.length, rule: opts.rule, horizons };
}

export interface RateLine {
  tokens: number;
  migrated: number;
  rate: number;
  wilson: Interval;
}

export interface MeasureSummary {
  roomLeft: RateLine;
  size: RateLine;
  rejected: RateLine;
  base: RateLine;
  /** Rate ratios; null when the denominator rate is zero. */
  liftOverBase: number | null;
  liftOverSize: number | null;
  /** Rate difference room-left minus base: Newcombe on tokens (assumes independent tokens: optimistic), and the cluster bootstrap over Metas. */
  diffOverBase: { newcombe: Interval; cluster?: Interval };
  diffOverSize: { newcombe: Interval; cluster?: Interval };
  verdict: string;
}

export interface HorizonSummary {
  horizonHours: number;
  snapshots: number;
  metasOffered: number;
  unfiltered: MeasureSummary;
  after60: MeasureSummary;
  copies: { checked: number; rejected: number };
}

export interface BacktestSummary {
  report: BacktestReport;
  horizons: HorizonSummary[];
}

/** A cluster bootstrap over fewer Metas than this is not an interval worth quoting. */
const MIN_TRUSTED_METAS = 10;

const line = (tokens: number, migrated: number): RateLine => ({ tokens, migrated, rate: tokens > 0 ? migrated / tokens : 0, wilson: wilson(migrated, tokens) });
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function summariseBacktest(report: BacktestReport, opts: { resamples?: number } = {}): BacktestSummary {
  const resamples = opts.resamples ?? 2_000;
  const horizons = report.horizons.map((h): HorizonSummary => {
    const measure = (pick: "migrated" | "migratedAfter60s", cl: "unfiltered" | "after60"): MeasureSummary => {
      const l = (name: ArmName) => line(h.arms[name].tokens, h.arms[name][pick]);
      const room = l("roomLeft");
      const size = l("size");
      const rejected = l("rejected");
      const base = l("base");
      const diff = (other: RateLine, otherClusters: Cluster[] | number): MeasureSummary["diffOverBase"] => {
        const c = clusterBootstrapDiff(h.clusters.roomLeft[cl], otherClusters, resamples);
        return { newcombe: newcombeDiff(room.migrated, room.tokens, other.migrated, other.tokens), ...(c ? { cluster: c } : {}) };
      };
      const overBase = diff(base, base.rate);
      const overSize = diff(size, h.clusters.size[cl]);
      let verdict: string;
      if (room.tokens === 0) verdict = "no data: no Meta passed the gates with a joiner in this horizon";
      else if (overBase.cluster === undefined) verdict = "no data";
      else if (overBase.cluster.low > 0) verdict = `lift over base: the cluster interval for the difference is above zero (${(overBase.cluster.low * 100).toFixed(1)} to ${(overBase.cluster.high * 100).toFixed(1)} points)`;
      else if (room.rate <= base.rate) verdict = "no lift: the room-left rate is not above the base rate";
      else verdict = `no lift shown: the rate is above base but the cluster interval includes zero (${(overBase.cluster.low * 100).toFixed(1)} to ${(overBase.cluster.high * 100).toFixed(1)} points)`;
      const metas = h.clusters.roomLeft[cl].length;
      if (room.tokens > 0 && metas < MIN_TRUSTED_METAS) verdict += `; only ${metas} distinct Metas, too few independent draws to trust this`;
      return { roomLeft: room, size, rejected, base, liftOverBase: ratio(room.rate, base.rate), liftOverSize: ratio(room.rate, size.rate), diffOverBase: overBase, diffOverSize: overSize, verdict };
    };
    return { horizonHours: h.horizonHours, snapshots: h.snapshots, metasOffered: h.arms.roomLeft.metas, unfiltered: measure("migrated", "unfiltered"), after60: measure("migratedAfter60s", "after60"), copies: h.copies };
  });
  return { report, horizons };
}

const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (i: Interval) => `${pc(i.low)}-${pc(i.high)}`;
const pts = (i: Interval | undefined) => (i ? `${(i.low * 100).toFixed(1)} to ${(i.high * 100).toFixed(1)} pts` : "n/a");
const x = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(2)}x`);

/** The report as plain text for the ticket's Comments. */
export function formatBacktest(s: BacktestSummary): string {
  const r = s.report;
  const out: string[] = [];
  out.push(`Beta backtest: ${r.snapshots} hourly snapshots from ${r.from} to ${r.to} (step ${r.stepMinutes} min), data to ${r.dataEnd}; top ${r.top} Metas per arm.`);
  out.push(`Rule: ${JSON.stringify(r.rule)}`);
  out.push(`Arms: roomLeft = top ${r.top} Metas that pass the gates (lead-cap gate off: no market cap as of T); size = top ${r.top} Metas by 24 h token count; rejected = Metas the gates removed; base = every create.`);
  out.push("A token counts for an arm when it was created in (T, T+H] in the Meta's group at T by a creator with no token in that group before T, and each token counts once per arm.");
  out.push("Intervals: Wilson 95% on the token rate (tokens treated as independent), and a cluster bootstrap over Metas for the difference (a Meta is one draw). Hourly snapshots overlap, so the independent sample is the number of distinct Metas, far below the token count.");
  for (const h of s.horizons) {
    out.push("");
    out.push(`== Horizon ${h.horizonHours} h: ${h.snapshots} snapshots, ${h.metasOffered} distinct Metas offered by room-left, ${h.copies.rejected} of ${h.copies.checked} room-left joiner names would be rejected by the distinct-name rule (copies of a group token)`);
    for (const [title, m] of [["migrated (unfiltered)", h.unfiltered], ["migrated more than 60 s after the create", h.after60]] as const) {
      out.push(`-- ${title}`);
      out.push("arm        tokens  migrated  rate    Wilson 95%");
      for (const name of ["roomLeft", "size", "rejected", "base"] as const) {
        const l = m[name];
        out.push(`${name.padEnd(10)} ${String(l.tokens).padStart(6)}  ${String(l.migrated).padStart(8)}  ${pc(l.rate).padStart(6)}  ${ci(l.wilson)}`);
      }
      out.push(`lift over base ${x(m.liftOverBase)}, over size ${x(m.liftOverSize)}; difference over base: Newcombe ${pts(m.diffOverBase.newcombe)}, cluster ${pts(m.diffOverBase.cluster)}; over size: Newcombe ${pts(m.diffOverSize.newcombe)}, cluster ${pts(m.diffOverSize.cluster)}`);
      out.push(`verdict: ${m.verdict}`);
    }
  }
  return out.join("\n");
}
