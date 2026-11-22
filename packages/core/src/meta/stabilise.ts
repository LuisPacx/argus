import type { GroupItem, GroupSubject } from "./grouping.ts";
import { carriedState, type PreviousMetas } from "./leaders.ts";
import type { CurrentMeta } from "./store.ts";

/**
 * Subject stabiliser (Christmas fix, ticket 02): plain code between the grouping answer and `applyGrouping`. The AI names and groups afresh
 * every run, and `applyGrouping` derives a subject's key from its top theme, so when the top theme changes (Christmas became Santa) the key
 * changes and the carried state (`enteredAt`, holding, leader) is lost. Here a subject whose member themes overlap a subject of the previous
 * run takes that subject's key, and `currentMetas` then carries the state by key as before. No I/O, no clock read other than the `now` given,
 * no schema change (ADR 0012, 0015, 0018); the answer it is given is never changed.
 */

export interface Stabilised {
  /** The answer's subjects, each with the key it inherited from the previous run where one matched, else its own fresh key. */
  subjects: GroupSubject[];
  /** Previous subjects no subject of this run matched, still inside the state window. */
  kept: CurrentMeta[];
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A previous subject's members: its stored member themes and its own key. */
const membersOf = (m: CurrentMeta): Set<string> => new Set([m.key, ...(m.themes ?? []).map((t) => t.key)]);

/**
 * The theme keys of every subject (Meta or Watching) of the previous run while it is inside the state window. The compute step passes them to
 * `buildGroupItems` so these themes reach the AI even below the 30-theme cut.
 */
export function previousThemeKeys(previous: PreviousMetas | undefined, now: Date, stateMaxMinutes: number): Set<string> {
  const carried = carriedState(previous, now, stateMaxMinutes);
  return new Set([...(carried?.metas ?? []), ...(carried?.watching ?? [])].flatMap((m) => [...membersOf(m)]));
}

type ThemeItem = Extract<GroupItem, { kind: "theme" }>;

interface Candidate {
  /** Index into the answer. */
  at: number;
  prev: CurrentMeta;
  overlap: number;
  /** Whether the subject holds the theme the previous subject was keyed by: its own identity, not a theme it merely shared. */
  ownKey: boolean;
  /** The creators behind the shared themes (this run's figures): the weight of what the subject really took over. */
  sharedCreators: number;
  derived: string;
}

export function stabiliseSubjects(subjects: readonly GroupSubject[], items: readonly GroupItem[], previous: PreviousMetas | undefined, now: Date, stateMaxMinutes: number): Stabilised {
  const carried = carriedState(previous, now, stateMaxMinutes);
  const prevs = [...(carried?.metas ?? []), ...(carried?.watching ?? [])];
  if (prevs.length === 0) return { subjects: subjects.map((s) => ({ ...s })), kept: [] };

  const themeById = new Map(items.flatMap((i) => (i.kind === "theme" ? [[i.id, i] as const] : [])));
  const themeByKey = new Map([...themeById.values()].map((t) => [t.key, t] as const));
  const themesOf = (s: GroupSubject): ThemeItem[] => s.items.flatMap((id) => themeById.get(id) ?? []);
  /** The member themes best first (most creators, then tokens, then smaller key): the first is what `applyGrouping` would key the subject by. */
  const ranked = (s: GroupSubject) => themesOf(s).sort((a, b) => b.creators - a.creators || b.tokens - a.tokens || cmpStr(a.key, b.key));

  const rankedBy = subjects.map(ranked);
  const derived = rankedBy.map((r) => r[0]?.key);

  // Every pair of a subject and a previous subject that share a member theme, strongest first: the most shared themes, then the subject that
  // holds the previous subject's own key theme, then the one with more creators behind the shared themes (ticket 07: Christmas {xmas} and
  // Grinch {grinch} both shared one theme with the previous Christmas {snowball, xmas, grinch}, and the order of the names gave Christmas'
  // key to Grinch). The last tie-breaks (smaller previous key, then smaller derived key) come from the data, so the result does not depend on
  // the order of the answer or of the previous run.
  const candidates: Candidate[] = [];
  for (const [at, r] of rankedBy.entries()) {
    const keys = new Set(r.map((t) => t.key));
    for (const prev of prevs) {
      const shared = [...membersOf(prev)].filter((k) => keys.has(k));
      if (shared.length === 0) continue;
      const sharedCreators = r.filter((t) => shared.includes(t.key)).reduce((n, t) => n + t.creators, 0);
      candidates.push({ at, prev, overlap: shared.length, ownKey: keys.has(prev.key), sharedCreators, derived: derived[at] as string });
    }
  }
  candidates.sort((a, b) => b.overlap - a.overlap || Number(b.ownKey) - Number(a.ownKey) || b.sharedCreators - a.sharedCreators || cmpStr(a.prev.key, b.prev.key) || cmpStr(a.derived, b.derived));

  const inherited = new Map<number, CurrentMeta>();
  const matchedPrev = new Set<CurrentMeta>();
  for (const c of candidates) {
    if (inherited.has(c.at) || matchedPrev.has(c.prev)) continue;
    inherited.set(c.at, c.prev);
    matchedPrev.add(c.prev);
  }
  const kept = prevs.filter((p) => !matchedPrev.has(p));

  // A previous key goes to one subject only: the inherited ones, and the kept ones (which stay as Watching under their own key).
  const taken = new Set(prevs.map((p) => p.key));
  const claimed = new Set(subjects.flatMap((s) => themesOf(s).map((t) => t.key)));

  const out = subjects.map((s): GroupSubject => ({ ...s }));
  for (const [at, prev] of inherited) {
    const subject = out[at] as GroupSubject;
    subject.key = prev.key;
    // The previous member themes the AI left out of every subject come back with the subject, so a one-run omission does not split it.
    const back = [...membersOf(prev)].sort(cmpStr).flatMap((k) => {
      const theme = themeByKey.get(k);
      return theme && !claimed.has(k) ? [theme] : [];
    });
    for (const t of back) claimed.add(t.key);
    subject.items = [...subject.items, ...back.map((t) => t.id)];
  }

  // The others get the key they would have had: their top theme, or the next one down, or a numbered one when that is taken. Taken in the
  // order of the derived key, so the numbers do not depend on the order of the answer.
  const fresh = [...rankedBy.keys()].filter((at) => !inherited.has(at) && derived[at] !== undefined).sort((a, b) => cmpStr(derived[a] as string, derived[b] as string));
  for (const at of fresh) {
    const members = (rankedBy[at] as ThemeItem[]).map((t) => t.key);
    const free = members.find((k) => !taken.has(k)) ?? numbered(members[0] as string, taken);
    taken.add(free);
    (out[at] as GroupSubject).key = free;
  }
  return { subjects: out, kept };
}

function numbered(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
