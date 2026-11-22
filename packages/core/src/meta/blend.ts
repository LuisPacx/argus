import { matchesField, norm, prepare, type Field } from "../term-match.ts";
import { isGenericKey } from "./group.ts";
import type { LeaderSubject } from "./leaders.ts";

/**
 * The terms a subject answers to in the blend pass (christmas-fix ticket 04, ADR 0012/0018): plain code over untrusted text, no I/O, no prompt hint.
 * A graduate such as `Bullmas`, `CATEMAS` or `pepesanta` carries no form that names the Christmas subject exactly, but it carries a word the subject is
 * built from. Two kinds of term:
 *
 * - Own terms: the subject's key, its label and the launch-theme keys it merged. At least `BLEND_OWN_MIN_CHARS` characters, never a generic key. This is
 *   where a short stem such as `mas` comes from (`termMatches` lets it match a blend like CATEMAS, never a name like Thomas).
 * - Learned stems: a word of 4 or more characters taken from the names and tickers of the subject's own tokens, kept only when at least
 *   `BLEND_STEM_CREATORS` distinct creators used it among the subject's tokens (one wallet cannot teach a stem) and at least `BLEND_STEM_SHARE_PCT` of all
 *   the tokens that carry it, in every subject, belong to this subject (self-consistency: a word every theme uses names none of them). "Carries" is a
 *   substring of the normalised name or ticker, so the numbers do not depend on how the creator split the words.
 */
export const BLEND_STEM_MIN_CHARS = 4;
export const BLEND_STEM_CREATORS = 3;
export const BLEND_STEM_SHARE_PCT = 70;
export const BLEND_OWN_MIN_CHARS = 3;

export interface BlendToken {
  name: string;
  symbol: string;
  /** Absent or empty: the token casts no creator vote for a stem. */
  creator?: string;
}
export type BlendSubject = Pick<LeaderSubject, "key" | "label" | "memberKeys"> & { tokens: readonly BlendToken[] };

const WORD_BREAK = /[^\p{L}\p{N}]+/u;
const FIELD_BREAK = "\u0000";

/**
 * The terms of every subject `include` admits, per subject index (empty for the rest). `probes` are the fields of the graduates still unassigned: a
 * learned stem is measured only when one of them carries it, which keeps the corpus scan to the handful of stems that could change an answer.
 */
export function blendTerms(subjects: readonly BlendSubject[], include: (subjectIndex: number) => boolean, probes: readonly Field[]): string[][] {
  const out: string[][] = subjects.map(() => []);
  let corpus: Array<{ hay: string; subject: number; creator: string }> | undefined;
  subjects.forEach((s, i) => {
    if (s.key.startsWith("unkeyed:") || !include(i)) return;
    const terms = new Set<string>();
    for (const raw of [s.key, s.label, ...(s.memberKeys ?? [])]) {
      const t = norm(raw);
      if ([...t].length >= BLEND_OWN_MIN_CHARS && !isGenericKey(t)) terms.add(t);
    }
    const candidates = new Set<string>();
    for (const t of s.tokens)
      for (const text of [norm(t.name), norm(t.symbol)])
        for (const w of text.split(WORD_BREAK)) if ([...w].length >= BLEND_STEM_MIN_CHARS && !isGenericKey(w) && !terms.has(w)) candidates.add(w);
    for (const stem of candidates) {
      if (!probes.some((p) => matchesField(stem, p))) continue;
      corpus ??= subjects.flatMap((o, j) => o.tokens.map((t) => ({ hay: `${norm(t.name)}${FIELD_BREAK}${norm(t.symbol)}`, subject: j, creator: t.creator ?? "" })));
      let total = 0;
      let own = 0;
      const creators = new Set<string>();
      for (const c of corpus) {
        if (!c.hay.includes(stem)) continue;
        total++;
        if (c.subject !== i) continue;
        own++;
        if (c.creator !== "") creators.add(c.creator);
      }
      if (creators.size >= BLEND_STEM_CREATORS && own * 100 >= total * BLEND_STEM_SHARE_PCT) terms.add(stem);
    }
    out[i] = [...terms];
  });
  return out;
}

/** The graduate's name and ticker, normalised and split once, however many terms are tried against them. */
export const graduateFields = (g: { name: string; symbol: string }): Field[] => [prepare(g.name, true), prepare(g.symbol, true)];

/** Whether any of the terms is in the graduate's name or ticker (the shared `matchesField` rule). */
export const blendMatches = (terms: readonly string[], fields: readonly Field[]): boolean => terms.some((t) => fields.some((f) => matchesField(t, f)));
