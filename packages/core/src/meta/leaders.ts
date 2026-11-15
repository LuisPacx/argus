import type { MetaConfig, MetaWindow } from "./config.ts";
import { isGenericKey } from "./group.ts";
import { subjectKey } from "./key.ts";
import type { CurrentLeader, CurrentMeta, MetaCounts, MetaTopToken } from "./store.ts";
import { DEFAULT_THEME_CONFIG, tokenWholeForms } from "./theme.ts";

/**
 * The market-led Meta rule (ADR 0014), pure: given the launch-theme subjects, the tokens with a current market cap and the last run's state,
 * says which subjects are Metas and which are Watching. No clock, no network, no database: the compute step gathers the inputs and stores
 * the answer.
 *
 *   - A subject is a launch-theme group. Its leader is the token of any age with the highest market cap that carries the subject: either
 *     the token names the group (a `subjectKey` form of it equals the group's key or a whole name of one of the group's tokens, never
 *     through a generic or too-short form), or the compute step says it belongs to the group (`groupKey`, the biggest token of a theme).
 *   - Becomes a Meta: leader at or above `enterMcapUsd`, looked up this run, and at least `minCopies` distinct creators in 24 h.
 *   - Stays a Meta: leader at or above `stayMcapUsd`, whatever the copies; between the two it is `holding`. At most `maxMetas`.
 *   - Watching: the top `watching` other subjects below `enterMcapUsd` that meet the copies rule.
 *   - A leader that was not looked up this run keeps its last figure (`stale`); it can keep a subject where it was but never creates a Meta.
 * Names are written by token creators: nothing here builds a RegExp from them, and every normaliser cuts its input.
 */

export interface LeaderSubject {
  /** The launch-theme group key. */
  key: string;
  label: string;
  counts: Record<MetaWindow, MetaCounts>;
  topTokens: MetaTopToken[];
  /** The group's tokens; their whole names are what a leader can match. */
  tokens: readonly { name: string; symbol: string }[];
}

export interface LeaderToken extends CurrentLeader {
  /** Set when the token is known to belong to this group (a theme's own token), so it needs no name match. */
  groupKey?: string;
}

/** The last run's Metas and Watching subjects, with the time of that run. */
export interface PreviousMetas {
  computedAt: string;
  metas: readonly CurrentMeta[];
  watching: readonly CurrentMeta[];
}

export type LeaderConfig = Pick<MetaConfig, "enterMcapUsd" | "stayMcapUsd" | "minCopies" | "maxMetas" | "watching" | "stateMaxMinutes" | "newsMinKeyChars">;

export interface CurrentMetasInput {
  subjects: readonly LeaderSubject[];
  /** Tokens whose market cap was read this run. A previous leader missing from here is carried at its last figure, marked stale. */
  tokens: readonly LeaderToken[];
  previous?: PreviousMetas;
  now: Date;
  config: LeaderConfig;
}

export interface CurrentMetasResult {
  metas: CurrentMeta[];
  watching: CurrentMeta[];
}

const MINUTE_MS = 60_000;
const ZERO: MetaCounts = { tokens: 0, creators: 0, migrations: 0, migrationsAfter60s: 0 };
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The forms of a token's name and ticker that can name a subject: each key and its spaces-removed twin, and the whole names. */
function tokenForms(t: { name: string; symbol: string }, minChars: number): Set<string> {
  const usable = (f: string) => f !== "" && [...f].length >= minChars && !isGenericKey(f);
  const out = new Set<string>();
  for (const k of subjectKey(t.name, t.symbol)) {
    const joined = k.replaceAll(" ", "");
    if (usable(k) && usable(joined)) {
      out.add(k);
      out.add(joined);
    } else if (usable(joined)) out.add(joined);
  }
  for (const f of tokenWholeForms(t, { ...DEFAULT_THEME_CONFIG, minKeyChars: minChars })) out.add(f);
  return out;
}

/** Which subjects a form names. Built once per run. */
function formIndex(subjects: readonly LeaderSubject[], minChars: number): Map<string, number[]> {
  const index = new Map<string, number[]>();
  const add = (form: string, i: number) => {
    const list = index.get(form);
    if (!list) index.set(form, [i]);
    else if (list[list.length - 1] !== i) list.push(i);
  };
  subjects.forEach((s, i) => {
    if (s.key.startsWith("unkeyed:")) return;
    for (const f of tokenForms({ name: s.key, symbol: "" }, minChars)) add(f, i);
    for (const t of s.tokens) for (const f of tokenForms(t, minChars)) add(f, i);
  });
  return index;
}

/** Counts of a subject that no copy was launched for in 24 h (a Meta that outlived its launch wave). */
const noCounts = (): Record<MetaWindow, MetaCounts> => ({ "6h": { ...ZERO }, "24h": { ...ZERO } });

function publicLeader(t: LeaderToken): CurrentLeader {
  return { mint: t.mint, name: t.name, symbol: t.symbol, marketCapUsd: t.marketCapUsd, ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}), source: t.source, stale: t.stale };
}

/** A better leader: higher market cap, then a fresh figure over a stale one, then the smaller mint. */
const betterLeader = (a: LeaderToken, b: LeaderToken): boolean =>
  a.marketCapUsd !== b.marketCapUsd ? a.marketCapUsd > b.marketCapUsd : a.stale !== b.stale ? !a.stale : a.mint < b.mint;

/** The previous run's state when it is recent enough to carry (a pause longer than `stateMaxMinutes`, or an unreadable time, drops it). */
export function carriedState(previous: PreviousMetas | undefined, now: Date, stateMaxMinutes: number): PreviousMetas | undefined {
  if (!previous) return undefined;
  const at = Date.parse(previous.computedAt);
  return Number.isFinite(at) && now.getTime() - at <= stateMaxMinutes * MINUTE_MS ? previous : undefined;
}

export function currentMetas(input: CurrentMetasInput): CurrentMetasResult {
  const { config, now } = input;
  const nowIso = now.toISOString();
  const minChars = config.newsMinKeyChars;

  const previous = carriedState(input.previous, now, config.stateMaxMinutes);
  const prevMetas = previous?.metas ?? [];
  const prevWatching = previous?.watching ?? [];

  // The tokens of this run, plus each previous leader the lookup did not answer, at its last figure.
  const tokens = new Map<string, LeaderToken>();
  for (const t of input.tokens) {
    const cur = tokens.get(t.mint);
    if (t.marketCapUsd > 0 && (!cur || betterLeader(t, cur))) tokens.set(t.mint, t);
  }
  for (const row of [...prevMetas, ...prevWatching]) {
    const l = row.leader;
    if (!tokens.has(l.mint) && l.marketCapUsd > 0) tokens.set(l.mint, { ...l, stale: true });
  }

  const subjects: LeaderSubject[] = [...input.subjects];
  const byKey = new Map<string, number>();
  subjects.forEach((s, i) => byKey.set(s.key, i));
  const index = formIndex(subjects, minChars);
  const copies = (i: number) => (subjects[i] as LeaderSubject).counts["24h"].creators;
  const prevMetaKeys = new Set(prevMetas.map((m) => m.key));
  /** A subject can be led when it meets the copies rule, or is a Meta already (staying does not need copies). */
  const open = (i: number) => copies(i) >= config.minCopies || prevMetaKeys.has((subjects[i] as LeaderSubject).key);

  /** The best subject a token names among those that pass `ok`: most distinct creators, then the smaller key. */
  const match = (t: LeaderToken, ok: (i: number) => boolean): number | undefined => {
    let best: number | undefined;
    for (const f of tokenForms(t, minChars))
      for (const i of index.get(f) ?? []) {
        if (!ok(i)) continue;
        if (best === undefined || copies(i) > copies(best) || (copies(i) === copies(best) && cmpStr((subjects[i] as LeaderSubject).key, (subjects[best] as LeaderSubject).key) < 0)) best = i;
      }
    return best;
  };

  // Which previous Meta each subject continues: by key, else through the previous leader's name, else a subject with no copies left.
  const continues = new Map<number, CurrentMeta>();
  for (const p of prevMetas) {
    let i = byKey.get(p.key);
    if (i === undefined) {
      const lead = tokens.get(p.leader.mint);
      i = lead ? match(lead, open) : undefined;
    }
    if (i === undefined) {
      subjects.push({ key: p.key, label: p.label, counts: noCounts(), topTokens: p.topTokens, tokens: [] });
      i = subjects.length - 1;
      byKey.set(p.key, i);
    }
    if (!continues.has(i)) continues.set(i, p);
  }

  // The leader of each subject: its highest-cap token.
  const leaders = new Map<number, LeaderToken>();
  const offer = (i: number, t: LeaderToken) => {
    const cur = leaders.get(i);
    if (!cur || betterLeader(t, cur)) leaders.set(i, t);
  };
  const ownByMint = new Map([...continues].map(([i, p]) => [p.leader.mint, i]));
  for (const t of tokens.values()) {
    if (t.groupKey !== undefined) {
      const i = byKey.get(t.groupKey);
      if (i !== undefined && open(i)) offer(i, t);
      continue;
    }
    const i = ownByMint.get(t.mint) ?? match(t, open);
    if (i !== undefined) offer(i, t);
  }

  interface Standing {
    i: number;
    leader: LeaderToken;
    prev: CurrentMeta | undefined;
  }
  const standing: Standing[] = [];
  for (const [i, leader] of leaders) standing.push({ i, leader, prev: continues.get(i) });
  const rank = (a: Standing, b: Standing) => b.leader.marketCapUsd - a.leader.marketCapUsd || cmpStr((subjects[a.i] as LeaderSubject).key, (subjects[b.i] as LeaderSubject).key);

  const metaCandidates = standing
    .filter((s) => (s.prev ? s.leader.marketCapUsd >= config.stayMcapUsd : s.leader.marketCapUsd >= config.enterMcapUsd && !s.leader.stale && copies(s.i) >= config.minCopies))
    .sort(rank)
    .slice(0, config.maxMetas);
  const isMeta = new Set(metaCandidates.map((s) => s.i));
  const watchingCandidates = standing
    .filter((s) => !isMeta.has(s.i) && s.leader.marketCapUsd < config.enterMcapUsd && copies(s.i) >= config.minCopies)
    .sort(rank)
    .slice(0, config.watching);

  const prevWatchingByKey = new Map(prevWatching.map((w) => [w.key, w]));
  const row = (s: Standing, kind: "meta" | "watching"): CurrentMeta => {
    const subject = subjects[s.i] as LeaderSubject;
    const sameKind = kind === "meta" ? s.prev : prevWatchingByKey.get(subject.key);
    return {
      key: subject.key,
      label: subject.label,
      leader: publicLeader(s.leader),
      holding: kind === "meta" && s.leader.marketCapUsd < config.enterMcapUsd,
      enteredAt: sameKind?.enteredAt ?? nowIso,
      counts: subject.counts,
      topTokens: subject.topTokens,
    };
  };
  return { metas: metaCandidates.map((s) => row(s, "meta")), watching: watchingCandidates.map((s) => row(s, "watching")) };
}
