import type { MetaConfig, MetaWindow } from "./config.ts";
import { isGenericKey } from "./group.ts";
import { subjectKey } from "./key.ts";
import type { CurrentGrads, CurrentLeader, CurrentMeta, CurrentTheme, MetaCounts, MetaTopToken } from "./store.ts";
import { DEFAULT_THEME_CONFIG, tokenWholeForms } from "./theme.ts";

/**
 * The graduation Meta rule (graduation Meta ticket 01, ADR 0018), pure: given the subjects with their graduation counts, the tokens with a
 * current market cap and the last run's state, says which subjects are Metas and which are Watching. No clock, no network, no database: the
 * compute step gathers the inputs (`graduates.ts` counts a subject's graduations) and stores the answer.
 *
 *   - A subject is a launch-theme group, or the AI grouping step's merge of several. A Meta is several tokens graduating on one narrative.
 *   - Becomes a Meta: at least `metaMinGrads` graduations in 24 h, from at least `metaMinCreators` distinct creators, and at least
 *     `metaLiveGrads6h` of them in the last 6 h.
 *   - Stays a Meta: at least `metaStayGrads` graduations in 24 h, for as long as the previous run is within `stateMaxMinutes`; below the enter
 *     rule it is `holding`. At most `maxMetas`, ranked by 24 h graduations, then 6 h, then creators.
 *   - Watching: a subject that is not a Meta with at least `watchMinGrads` in 24 h or `watchGrads6h` in 6 h; the top `watching` by 6 h, then 24 h.
 *   - Market cap leaves the rule. The leader is the highest-priced token that carries the subject (a graduate, a launch-theme token or a
 *     trending token that names it), else the subject's latest graduate with a cap of 0 (shown as a dash). A trending token never makes a Meta.
 * Names are written by token creators: nothing here builds a RegExp from them, and every normaliser cuts its input.
 */

/** A token that graduated on a subject: what a leader needs when no token of the subject has a price. */
export interface LeaderGraduate {
  mint: string;
  /** Cleaned creator text: untrusted. */
  name: string;
  symbol: string;
  createdAt?: string;
  /** PumpPortal receipt time of the migrate event (ISO). */
  migratedAt: string;
}

export interface LeaderSubject {
  /** The launch-theme group key. */
  key: string;
  label: string;
  counts: Record<MetaWindow, MetaCounts>;
  topTokens: MetaTopToken[];
  /** The group's tokens; their whole names are what a leader can match. */
  tokens: readonly { name: string; symbol: string }[];
  /** The subject's graduations (the rule reads these). */
  grads: CurrentGrads;
  /** The subject's graduates of the last 24 h: they belong to it whatever their names, and the latest leads it when none is priced. */
  graduates?: readonly LeaderGraduate[];
  /** Who named it; absent reads as `rules`. */
  namedBy?: "ai" | "rules";
  /** A subject the grouping step built: the launch-theme keys it merged (a leader or a previous Meta that names one of them belongs to it). */
  memberKeys?: readonly string[];
  /** A subject the grouping step built: the trending tokens it holds (explicit membership: these mints lead this subject and no other, whatever their names). */
  memberMints?: readonly string[];
  /** The member themes shown under it. */
  themes?: CurrentTheme[];
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

export type LeaderConfig = Pick<MetaConfig, "metaMinGrads" | "metaStayGrads" | "metaMinCreators" | "metaLiveGrads6h" | "watchMinGrads" | "watchGrads6h" | "maxMetas" | "watching" | "stateMaxMinutes" | "newsMinKeyChars">;

export interface CurrentMetasInput {
  subjects: readonly LeaderSubject[];
  /** Tokens whose market cap was read this run. A previous leader missing from here is carried at its last figure, marked stale. */
  tokens: readonly LeaderToken[];
  previous?: PreviousMetas;
  /**
   * The trending tokens the AI grouping step was shown this run (set only when its answer was applied). A previous leader in it that the
   * answer did not put in its subject keeps that subject only through a name that still matches it, never through having led it last run.
   */
  grouped?: ReadonlySet<string>;
  now: Date;
  config: LeaderConfig;
}

export interface CurrentMetasResult {
  metas: CurrentMeta[];
  watching: CurrentMeta[];
}

const MINUTE_MS = 60_000;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The forms of a token's name and ticker that can name a subject: each key and its spaces-removed twin, and the whole names. */
export function tokenForms(t: { name: string; symbol: string }, minChars: number): Set<string> {
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

/** The parts of a subject a form index reads. */
export type IndexedSubject = Pick<LeaderSubject, "key" | "label" | "tokens" | "memberKeys">;

/**
 * Which subjects a form names. Built once per run. The subject's own key, its name and the keys of the launch themes it merged always name it;
 * a form of one of its tokens names it only when at least `DEFAULT_THEME_CONFIG.keyShare` (10 %) of the subject's tokens carry it (the share rule
 * `theme.ts` uses for an anchor's subject forms). One spam launch that copies a big token's ticker (two `dacity coin / fartcoin` creates inside
 * the 559-token GTA 6 cluster, meta redesign ticket 13) is not the subject's name, so that big token cannot match the subject through it.
 * `include` leaves subjects out (a subject nobody could match is not indexed).
 */
export function formIndex(subjects: readonly IndexedSubject[], minChars: number, include: (i: number) => boolean = () => true): Map<string, number[]> {
  const index = new Map<string, number[]>();
  const add = (form: string, i: number) => {
    const list = index.get(form);
    if (!list) index.set(form, [i]);
    else if (list[list.length - 1] !== i) list.push(i);
  };
  subjects.forEach((s, i) => {
    if (s.key.startsWith("unkeyed:") || !include(i)) return;
    for (const name of [s.key, s.label, ...(s.memberKeys ?? [])]) for (const f of tokenForms({ name, symbol: "" }, minChars)) add(f, i);
    const carried = new Map<string, number>();
    for (const t of s.tokens) for (const f of tokenForms(t, minChars)) carried.set(f, (carried.get(f) ?? 0) + 1);
    const need = Math.ceil(s.tokens.length * DEFAULT_THEME_CONFIG.keyShare);
    for (const [f, n] of carried) if (n >= need) add(f, i);
  });
  return index;
}

function publicLeader(t: LeaderToken): CurrentLeader {
  return { mint: t.mint, name: t.name, symbol: t.symbol, marketCapUsd: t.marketCapUsd, ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}), source: t.source, stale: t.stale, freshAt: t.freshAt };
}

/** A better leader: higher market cap, then a fresh figure over a stale one, then the smaller mint. */
const betterLeader = (a: LeaderToken, b: LeaderToken): boolean =>
  a.marketCapUsd !== b.marketCapUsd ? a.marketCapUsd > b.marketCapUsd : a.stale !== b.stale ? !a.stale : a.mint < b.mint;

/** The subject's grads with its 3 newest graduates (newest first, ties by the smaller mint) and the market cap of each that was priced this run. */
function withNewest(grads: CurrentGrads, list: readonly LeaderGraduate[] | undefined, priced: ReadonlyMap<string, LeaderToken>): CurrentGrads {
  const sorted = [...(list ?? [])].sort((a, b) => (a.migratedAt === b.migratedAt ? (a.mint < b.mint ? -1 : 1) : a.migratedAt < b.migratedAt ? 1 : -1)).slice(0, 3);
  if (sorted.length === 0) return grads;
  return { ...grads, newest: sorted.map((g) => { const cap = priced.get(g.mint)?.marketCapUsd; return { mint: g.mint, name: g.name, symbol: g.symbol, ...(cap !== undefined && cap > 0 ? { marketCapUsd: cap } : {}) }; }) };
}

/** The latest graduate (by graduation time, then the smaller mint), as a leader with no market cap: a dash on every page. */
function latestGraduate(list: readonly LeaderGraduate[] | undefined, nowIso: string): CurrentLeader | undefined {
  let best: LeaderGraduate | undefined;
  for (const g of list ?? []) if (!best || g.migratedAt > best.migratedAt || (g.migratedAt === best.migratedAt && g.mint < best.mint)) best = g;
  if (!best) return undefined;
  return { mint: best.mint, name: best.name, symbol: best.symbol, marketCapUsd: 0, ...(best.createdAt !== undefined ? { createdAt: best.createdAt } : {}), source: "theme", stale: false, freshAt: nowIso };
}

/**
 * The previous run's state that may be carried: none when the run itself is older than `stateMaxMinutes` (a pause) or its time is unreadable.
 * A Meta stays on the stay rule alone (graduation counts are read live every run), so its rows need no fresh leader figure to be carried; a
 * leader's figure older than `stateMaxMinutes` is dropped by `currentMetas`, which then shows the dash.
 */
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

  // The tokens of this run, plus each previous leader the lookup did not answer, at its last figure (marked stale) while that figure is
  // younger than `stateMaxMinutes`.
  const tokens = new Map<string, LeaderToken>();
  for (const t of input.tokens) {
    const cur = tokens.get(t.mint);
    if (t.marketCapUsd > 0 && (!cur || betterLeader(t, cur))) tokens.set(t.mint, t);
  }
  const figureAge = (l: CurrentLeader) => now.getTime() - Date.parse(l.freshAt);
  for (const row of [...prevMetas, ...prevWatching]) {
    const l = row.leader;
    if (!tokens.has(l.mint) && l.marketCapUsd > 0 && figureAge(l) <= config.stateMaxMinutes * MINUTE_MS) tokens.set(l.mint, { ...l, stale: true });
  }

  const subjects: LeaderSubject[] = [...input.subjects];
  // A group key finds its subject: the subject's own key, or the key of a launch theme the grouping step merged into it (members first, so a
  // subject's own key always wins a clash). A trending token the grouping step put in a subject leads that subject by membership, not by name.
  const byKey = new Map<string, number>();
  subjects.forEach((s, i) => {
    for (const k of s.memberKeys ?? []) byKey.set(k, i);
  });
  subjects.forEach((s, i) => byKey.set(s.key, i));
  const members = new Map<string, number>();
  const graduateOf = new Map<string, number>();
  subjects.forEach((s, i) => {
    for (const m of s.memberMints ?? []) members.set(m, i);
    for (const g of s.graduates ?? []) graduateOf.set(g.mint, i);
  });
  const index = formIndex(subjects, minChars);
  const g24 = (i: number) => (subjects[i] as LeaderSubject).grads["24h"];

  /** The subject that holds this token without a name match: a trending token the grouping step placed, or a graduate of the subject. */
  const heldBy = (mint: string): number | undefined => members.get(mint) ?? graduateOf.get(mint);

  /** The best subject a token names among those that pass `ok`: most 24 h graduations, then the smaller key. */
  const match = (t: LeaderToken, ok: (i: number) => boolean): number | undefined => {
    let best: number | undefined;
    for (const f of tokenForms(t, minChars))
      for (const i of index.get(f) ?? []) {
        if (!ok(i)) continue;
        if (best === undefined || g24(i) > g24(best) || (g24(i) === g24(best) && cmpStr((subjects[i] as LeaderSubject).key, (subjects[best] as LeaderSubject).key) < 0)) best = i;
      }
    return best;
  };

  /** Whether one of the token's name forms names subject `i`. */
  const names = (t: LeaderToken, i: number): boolean => [...tokenForms(t, minChars)].some((f) => index.get(f)?.includes(i));

  // Which previous Meta each subject continues: by key, else through the previous leader's place in a subject, else it has ended.
  const canStay = (i: number) => g24(i) >= config.metaStayGrads;
  const continues = new Map<number, CurrentMeta>();
  for (const p of prevMetas) {
    let i = byKey.get(p.key);
    if (i === undefined) {
      const lead = tokens.get(p.leader.mint);
      i = heldBy(p.leader.mint) ?? (lead ? match(lead, canStay) : undefined);
    }
    if (i !== undefined && !continues.has(i)) continues.set(i, p);
  }

  // Who is a Meta and who is Watching: graduation counts only, no market cap and no leader needed.
  const unkeyed = (i: number) => (subjects[i] as LeaderSubject).key.startsWith("unkeyed:");
  const enters = (i: number) => {
    const g = (subjects[i] as LeaderSubject).grads;
    return g["24h"] >= config.metaMinGrads && g.creators24h >= config.metaMinCreators && g["6h"] >= config.metaLiveGrads6h;
  };
  const byGrads24 = (a: number, b: number) => {
    const x = (subjects[a] as LeaderSubject).grads;
    const y = (subjects[b] as LeaderSubject).grads;
    return y["24h"] - x["24h"] || y["6h"] - x["6h"] || y.creators24h - x.creators24h || cmpStr((subjects[a] as LeaderSubject).key, (subjects[b] as LeaderSubject).key);
  };
  const byGrads6 = (a: number, b: number) => {
    const x = (subjects[a] as LeaderSubject).grads;
    const y = (subjects[b] as LeaderSubject).grads;
    return y["6h"] - x["6h"] || y["24h"] - x["24h"] || y.creators24h - x.creators24h || cmpStr((subjects[a] as LeaderSubject).key, (subjects[b] as LeaderSubject).key);
  };
  const all = subjects.map((_, i) => i).filter((i) => !unkeyed(i));
  const metaIdx = all
    .filter((i) => enters(i) || (continues.has(i) && canStay(i)))
    .sort(byGrads24)
    .slice(0, config.maxMetas);
  const isMeta = new Set(metaIdx);
  const watchingIdx = all
    .filter((i) => !isMeta.has(i) && ((subjects[i] as LeaderSubject).grads["24h"] >= config.watchMinGrads || (subjects[i] as LeaderSubject).grads["6h"] >= config.watchGrads6h))
    .sort(byGrads6)
    .slice(0, config.watching);
  const open = new Set([...metaIdx, ...watchingIdx]);

  // The leader of each Meta and Watching subject: its highest-cap token.
  const leaders = new Map<number, LeaderToken>();
  const offer = (i: number, t: LeaderToken) => {
    const cur = leaders.get(i);
    if (!cur || betterLeader(t, cur)) leaders.set(i, t);
  };
  const ownByMint = new Map([...continues].map(([i, p]) => [p.leader.mint, i]));
  for (const t of tokens.values()) {
    const held = heldBy(t.mint);
    if (held !== undefined) {
      if (open.has(held)) offer(held, t);
      continue;
    }
    if (t.groupKey !== undefined) {
      const i = byKey.get(t.groupKey);
      if (i !== undefined && open.has(i)) offer(i, t);
      continue;
    }
    const i = ownByMint.get(t.mint);
    // A previous leader keeps its subject without a name match, unless the AI step saw it this run and left it out of that subject: a wrong
    // leader cannot hold a Meta for ever by having led it (ticket 13). On a run with no AI answer the carry stands.
    if (i !== undefined && (!input.grouped?.has(t.mint) || names(t, i))) {
      if (open.has(i)) offer(i, t);
    } else {
      const j = match(t, (k) => open.has(k));
      if (j !== undefined) offer(j, t);
    }
  }

  const prevWatchingByKey = new Map(prevWatching.map((w) => [w.key, w]));
  const row = (i: number, kind: "meta" | "watching"): CurrentMeta | undefined => {
    const subject = subjects[i] as LeaderSubject;
    const priced = leaders.get(i);
    // No priced token: the latest graduate with the cap shown as a dash, else the previous leader as it was (a row stored before this run).
    const leader = priced ? publicLeader(priced) : (latestGraduate(subject.graduates, nowIso) ?? (kind === "meta" ? continues.get(i)?.leader : prevWatchingByKey.get(subject.key)?.leader));
    if (!leader) return undefined;
    const sameKind = kind === "meta" ? continues.get(i) : prevWatchingByKey.get(subject.key);
    return {
      key: subject.key,
      label: subject.label,
      namedBy: subject.namedBy ?? "rules",
      themes: subject.themes ?? [],
      leader,
      holding: kind === "meta" && !enters(i),
      enteredAt: sameKind?.enteredAt ?? nowIso,
      counts: subject.counts,
      grads: withNewest(subject.grads, subject.graduates, tokens),
      topTokens: subject.topTokens,
    };
  };
  const rows = (list: readonly number[], kind: "meta" | "watching") => list.flatMap((i) => row(i, kind) ?? []);
  return { metas: rows(metaIdx, "meta"), watching: rows(watchingIdx, "watching") };
}
