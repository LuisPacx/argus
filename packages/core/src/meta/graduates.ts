import type { GraduatedToken } from "../study/store.ts";
import { META_WINDOW_HOURS } from "./config.ts";
import { formIndex, tokenForms, type IndexedSubject } from "./leaders.ts";
import type { CurrentGrads } from "./store.ts";
import { DEFAULT_THEME_CONFIG, tokenSubjectForms } from "./theme.ts";

/**
 * Which subject each graduate belongs to, and what a subject's graduations come to (graduation Meta ticket 01, ADR 0018). Pure: no clock, no
 * network, no database.
 *
 * A graduate whose create is in the 24 h read belongs to the subject that holds that create (`mintSubject`: exact, never ambiguous). Any other
 * graduate (a late graduate of an old create, or a migration whose create was never seen with a name) is matched by the forms of its name and
 * ticker, the way the launch themes group: each key, its spaces-removed twin, its whole names, and its single words and adjacent pairs
 * (`tokenSubjectForms`: `Santa Inu` has `santa`, `snowball-v2` has `snowball`). A form names a subject when it is the subject's own key, its name,
 * one of its merged theme keys, or one that a tenth of its tokens carry (`formIndex`). A graduate whose forms name two subjects is ambiguous and
 * joins none; one that names none joins none. Both still count in the window's total, which is only the denominator of the display share.
 */

export interface GraduateAssignment {
  /** Per subject index. */
  grads: CurrentGrads[];
  graduates: GraduatedToken[][];
}

export interface AssignInput {
  subjects: readonly IndexedSubject[];
  graduates: readonly GraduatedToken[];
  /** The subject that holds each token created in the read (by mint). */
  mintSubject: ReadonlyMap<string, number>;
  /** Subjects a graduate without a create in the read may be matched to by name (the rest only hold their own tokens' graduations). */
  nameable: (subjectIndex: number) => boolean;
  nowMs: number;
  /** The shortest form that may name a subject (`newsMinKeyChars`). */
  minKeyChars: number;
}

const HOUR_MS = 3_600_000;

export function assignGraduates(input: AssignInput): GraduateAssignment {
  const { subjects, graduates, nowMs, minKeyChars } = input;
  const from24 = nowMs - META_WINDOW_HOURS["24h"] * HOUR_MS;
  const from6 = nowMs - META_WINDOW_HOURS["6h"] * HOUR_MS;
  const index = formIndex(subjects, minKeyChars, input.nameable);
  const themeConfig = { ...DEFAULT_THEME_CONFIG, minKeyChars };
  const seen = new Set<string>();
  const owned: GraduatedToken[][] = subjects.map(() => []);
  let total = 0;
  for (const g of graduates) {
    if (seen.has(g.mint)) continue;
    seen.add(g.mint);
    const at = Date.parse(g.migratedAt);
    if (!(at >= from24 && at <= nowMs)) continue;
    total++;
    let subject = input.mintSubject.get(g.mint);
    if (subject === undefined) {
      const hits = new Set<number>();
      for (const f of new Set([...tokenForms(g, minKeyChars), ...tokenSubjectForms(g, themeConfig)])) for (const i of index.get(f) ?? []) hits.add(i);
      if (hits.size === 1) subject = [...hits][0];
    }
    if (subject !== undefined) (owned[subject] as GraduatedToken[]).push(g);
  }
  const grads = owned.map((list): CurrentGrads => {
    const creators = new Set<string>();
    let last6 = 0;
    for (const g of list) {
      if (g.creator !== "") creators.add(g.creator);
      if (Date.parse(g.migratedAt) >= from6) last6++;
    }
    return { "24h": list.length, "6h": last6, creators24h: creators.size, share: total > 0 ? Math.round((list.length / total) * 10_000) / 10_000 : 0 };
  });
  return { grads, graduates: owned };
}
