import { cleanLabel } from "../meta/group.ts";
import { normaliseKey } from "../meta/key.ts";

/**
 * The distinct-name rule for a Beta (viral sources ticket 04, slice 2): a Beta must not be a copy of a token already in its Meta group.
 * Rejected when the normalised name equals, or the normalised ticker equals, or the normalised name is within one edit of, any
 * existing token key (the name key and the ticker key of every group token). The comparator is the Meta ranking's own `normaliseKey`
 * (ticket 03, slice 1), so case, `$`, punctuation, emoji, zero-width and full-width forms do not make a name distinct.
 *
 * Everything compared is creator-written text or model output: untrusted. No RegExp is built from any of it; keys are cut at 64
 * characters by `normaliseKey` and compared with a linear scan, so a 10,000-character name costs the same as a long one.
 */

export interface ExistingToken {
  name: string;
  symbol: string;
}

export interface BetaNameCandidate {
  name: string;
  ticker: string;
}

export type DistinctResult = { ok: true } | { ok: false; reason: string; /** The existing tokens it copies, as display labels (still creator text). */ offending: string[] };

/** A one-edit match is only trusted when both keys are at least this long; on shorter keys one edit changes the word (cat, car). */
const MIN_FUZZY_CHARS = 4;
/** At most this many offending names are listed back to the model. */
const MAX_OFFENDING = 8;

/** True when two strings are equal or differ by one insertion, deletion or substitution, by code point. Linear time. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  // Past the shared prefix exactly one difference is allowed.
  if (x.length === y.length) {
    for (let k = i + 1; k < x.length; k++) if (x[k] !== y[k]) return false;
    return true;
  }
  const [long, short] = x.length > y.length ? [x, y] : [y, x];
  for (let k = i; k < short.length; k++) if (long[k + 1] !== short[k]) return false;
  return true;
}

/** Whether a Beta's name and ticker are distinct from every token in the group. */
export function checkDistinctName(candidate: BetaNameCandidate, existing: readonly ExistingToken[]): DistinctResult {
  const nameKey = normaliseKey(candidate.name);
  const tickerKey = normaliseKey(candidate.ticker);
  if (nameKey === "") return { ok: false, reason: "the name has no letters or digits once emoji, symbols and punctuation are removed", offending: [] };
  const offending: string[] = [];
  const add = (label: string) => {
    const shown = cleanLabel(label);
    if (offending.length < MAX_OFFENDING && !offending.includes(shown)) offending.push(shown);
  };
  let exactName = false;
  let exactTicker = false;
  let nearName = false;
  for (const t of existing) {
    for (const key of new Set([normaliseKey(t.name), normaliseKey(t.symbol)])) {
      if (key === "") continue;
      if (key === nameKey) {
        exactName = true;
        add(t.name || t.symbol);
      } else if (tickerKey !== "" && key === tickerKey) {
        exactTicker = true;
        add(t.name || t.symbol);
      } else if ([...key].length >= MIN_FUZZY_CHARS && [...nameKey].length >= MIN_FUZZY_CHARS && withinOneEdit(key, nameKey)) {
        nearName = true;
        add(t.name || t.symbol);
      }
    }
  }
  if (!exactName && !exactTicker && !nearName) return { ok: true };
  const why = exactName ? "the name is the same as an existing token's" : exactTicker ? "the ticker is the same as an existing token's" : "the name is one edit from an existing token's";
  return { ok: false, reason: why, offending };
}

export type DistinctOutcome<T> = { ok: true; value: T; attempts: number } | { ok: false; reason: string; offending: string[]; attempts: number };

/**
 * Asks for a Beta name and, if it copies a group token, goes back exactly once with the offending names listed, then fails closed. The
 * model's second answer is checked the same way and never repaired here. An error from `ask` itself (a rate limit, a refusal) is not
 * a copy: it propagates and nothing is retried.
 */
export async function distinctOrRetryOnce<T extends BetaNameCandidate>(
  ask: (avoid?: string[]) => Promise<T>,
  existing: readonly ExistingToken[],
): Promise<DistinctOutcome<T>> {
  const first = await ask();
  const a = checkDistinctName(first, existing);
  if (a.ok) return { ok: true, value: first, attempts: 1 };
  const second = await ask(a.offending);
  const b = checkDistinctName(second, existing);
  if (b.ok) return { ok: true, value: second, attempts: 2 };
  return { ok: false, reason: b.reason, offending: b.offending, attempts: 2 };
}
