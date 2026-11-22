import type { GraduatedToken } from "../study/store.ts";
import type { Field } from "../term-match.ts";
import { blendMatches, blendTerms, graduateFields, type BlendSubject } from "./blend.ts";
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
  subjects: readonly (IndexedSubject & BlendSubject)[];
  graduates: readonly GraduatedToken[];
  /**
   * The Meta bar. When given, the blend pass runs: a graduate that no earlier pass placed may join the one subject whose terms it carries (`blend.ts`),
   * and only a subject still below this bar after the earlier passes may receive it.
   */
  bar?: { minGrads: number; minCreators: number; live6h: number };
  /** Subjects that were a Meta on the previous tick: kept by hysteresis (`metaStayGrads`) they may sit below `bar`, yet they are strong and gain no blends. */
  wasMeta?: (subjectIndex: number) => boolean;
  /** The subject that holds each token created in the read (by mint). */
  mintSubject: ReadonlyMap<string, number>;
  /** Subjects a graduate without a create in the read may be matched to by name (the rest only hold their own tokens' graduations). */
  nameable: (subjectIndex: number) => boolean;
  nowMs: number;
  /** The shortest form that may name a subject (`newsMinKeyChars`). */
  minKeyChars: number;
}

const HOUR_MS = 3_600_000;

/**
 * The blend pass (christmas-fix ticket 04, ADR 0012/0018): names like `Bullmas`, `CATEMAS` or `pepesanta` carry no form that names a subject exactly, but
 * they carry a word the subject is built from (`blend.ts`). A loose graduate joins a subject only when exactly one nameable subject's terms match it
 * (two or more is ambiguous: it joins none), and only when that subject is still below the Meta bar on what the exact passes gave it: a subject that
 * is already a Meta (over the bar, or one the previous tick had and hysteresis keeps) gains nothing, so the pass can lift a weak subject over the bar but never pad a strong one. Graduates placed by an earlier pass,
 * or ambiguous in it, are not in `loose` and are never moved.
 */
function blend(input: AssignInput, loose: readonly GraduatedToken[], owned: GraduatedToken[][], from6: number): Set<string> {
  const blended = new Set<string>();
  const bar = input.bar as NonNullable<AssignInput["bar"]>;
  const weak = owned.map((list, i) => {
    if (input.wasMeta?.(i)) return false;
    const creators = new Set(list.filter((g) => g.creator !== "").map((g) => g.creator));
    const live = list.filter((g) => Date.parse(g.migratedAt) >= from6).length;
    return !(list.length >= bar.minGrads && creators.size >= bar.minCreators && live >= bar.live6h);
  });
  const fields = loose.map(graduateFields);
  const terms = blendTerms(input.subjects, input.nameable, fields.flat());
  loose.forEach((g, n) => {
    const matched: number[] = [];
    terms.forEach((t, i) => {
      if (blendMatches(t, fields[n] as Field[])) matched.push(i);
    });
    if (matched.length === 1 && weak[matched[0] as number]) {
      (owned[matched[0] as number] as GraduatedToken[]).push(g);
      blended.add(g.mint);
    }
  });
  return blended;
}

export function assignGraduates(input: AssignInput): GraduateAssignment {
  const { subjects, graduates, nowMs, minKeyChars } = input;
  const from24 = nowMs - META_WINDOW_HOURS["24h"] * HOUR_MS;
  const from6 = nowMs - META_WINDOW_HOURS["6h"] * HOUR_MS;
  const index = formIndex(subjects, minKeyChars, input.nameable);
  const themeConfig = { ...DEFAULT_THEME_CONFIG, minKeyChars };
  const seen = new Set<string>();
  const owned: GraduatedToken[][] = subjects.map(() => []);
  /** In the window, with no create held by a subject and no form naming one: the only graduates the blend pass looks at. */
  const loose: GraduatedToken[] = [];
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
      else if (hits.size === 0) loose.push(g);
    }
    if (subject !== undefined) (owned[subject] as GraduatedToken[]).push(g);
  }
  const blended = input.bar && loose.length > 0 ? blend(input, loose, owned, from6) : new Set<string>();
  const grads = owned.map((list): CurrentGrads => {
    const creators = new Set<string>();
    let last6 = 0;
    for (const g of list) {
      if (g.creator !== "") creators.add(g.creator);
      if (Date.parse(g.migratedAt) >= from6) last6++;
    }
    const byBlend = list.filter((g) => blended.has(g.mint)).length;
    return { "24h": list.length, "6h": last6, creators24h: creators.size, share: total > 0 ? Math.round((list.length / total) * 10_000) / 10_000 : 0, ...(byBlend > 0 ? { blended: byBlend } : {}) };
  });
  return { grads, graduates: owned };
}
