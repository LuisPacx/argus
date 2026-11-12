import { isGenericKey, type GroupableToken, type TokenGroup } from "./group.ts";
import { normaliseKey } from "./key.ts";

/**
 * Theme Metas (ticket 03, slice 2): names that riff on a big Meta's subject word (`Ni Hao Noon`, `Mi Hao Sem`, `GTA 6 Cat`, `OG GTA 6 Cat`)
 * join that Meta's clone cluster, so a theme counts its many spellings and the creators behind them instead of one cluster of exact keys.
 *
 * The rule, chosen for precision on a labelled set from the DB copy (docs/adr/0012):
 *   - An ANCHOR is a clone cluster of at least `minAnchorCreators` distinct creators. Only anchors absorb; singletons and small clusters never
 *     join each other, so a one-word carrier ("pepe", "inu") cannot fuse unrelated names.
 *   - An anchor's SUBJECT FORMS are the whole name or ticker keys (spaces removed, accents folded) that at least `keyShare` of its tokens carry,
 *     at least `minKeyChars` long and not generic. For the ni hao cluster that is `nihao` and `mihao`; for GTA VI `gta6` and `gtavi`.
 *   - A TAIL (any other cluster) joins an anchor when at least `tailShare` of its tokens have a word, or two adjacent words joined (`ni hao` is
 *     `nihao`, `gta 6` is `gta6`), equal to one of the anchor's subject forms. A cluster is judged by its share of tokens, not by one bridge token:
 *     `Ni Hao Ansem` sitting in the Ansem cluster does not pull that cluster into ni hao.
 *   - A tail that matches two anchors joins neither (ambiguous). Anchors never merge with each other.
 * No embedding and no description text: gte-small does not separate these (measured, ADR 0012). Linear in the tokens; the names are
 * untrusted and only fixed literal patterns are applied, one code point at a time.
 */
export interface ThemeConfig {
  /** A clone cluster needs this many distinct creators to absorb others. Infinity switches theme merging off. */
  minAnchorCreators: number;
  /** Share of an anchor's tokens that must carry a form for it to be a subject form. */
  keyShare: number;
  /** Share of a tail's tokens that must carry a subject form for the tail to join. */
  tailShare: number;
  /** A subject form shorter than this many characters is never matched (`hope`, `goat` are real words; `gta6` is the shortest wanted). */
  minKeyChars: number;
}

export const DEFAULT_THEME_CONFIG: ThemeConfig = { minAnchorCreators: 30, keyShare: 0.1, tailShare: 0.5, minKeyChars: 4 };

const MARKS = /[̀-ͯ]/g;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The normalised key of a name or ticker with Latin accents folded (`Ní hao` is `ni hao`). Empty when nothing is left. */
const foldedKey = (text: string): string => normaliseKey(text.normalize("NFD").replace(MARKS, ""));

const usable = (form: string, config: ThemeConfig): boolean => [...form].length >= config.minKeyChars && !isGenericKey(form);

/** The whole keys of a token with spaces removed: what an anchor's subject forms are drawn from. */
function wholeForms(t: GroupableToken): Set<string> {
  const out = new Set<string>();
  for (const text of [t.name, t.symbol]) {
    const key = foldedKey(text);
    if (key !== "") out.add(key.replaceAll(" ", ""));
  }
  return out;
}

/** What a token's name or ticker could say about a subject: each word, each two adjacent words joined, and the whole key. */
function formsOf(t: GroupableToken, config: ThemeConfig): Set<string> {
  const out = new Set<string>();
  for (const text of [t.name, t.symbol]) {
    const key = foldedKey(text);
    if (key === "") continue;
    const words = key.split(" ");
    for (const [i, w] of words.entries()) {
      out.add(w);
      const next = words[i + 1];
      if (next !== undefined) out.add(w + next);
    }
    out.add(words.join(""));
  }
  for (const f of out) if (!usable(f, config)) out.delete(f);
  return out;
}

function creatorsOf<T extends GroupableToken & { creator: string }>(group: TokenGroup<T>): number {
  const set = new Set<string>();
  for (const t of group.tokens) if (t.creator !== "") set.add(t.creator);
  return set.size;
}

/** The anchor's subject forms: whole keys carried by at least `keyShare` of its tokens. */
function subjectForms<T extends GroupableToken>(group: TokenGroup<T>, config: ThemeConfig): Set<string> {
  const counts = new Map<string, number>();
  for (const t of group.tokens) for (const f of wholeForms(t)) counts.set(f, (counts.get(f) ?? 0) + 1);
  const out = new Set<string>();
  for (const [f, n] of counts) if (n / group.tokens.length >= config.keyShare && usable(f, config)) out.add(f);
  return out;
}

/** Folds small clusters into the anchors whose subject they name. Returns the groups biggest first, then by key, like `groupTokens`. */
export function mergeThemes<T extends GroupableToken & { creator: string }>(groups: TokenGroup<T>[], config: ThemeConfig = DEFAULT_THEME_CONFIG): TokenGroup<T>[] {
  const anchors = groups
    .filter((g) => creatorsOf(g) >= config.minAnchorCreators)
    .map((group) => ({ group, forms: subjectForms(group, config), absorbed: [] as TokenGroup<T>[] }))
    .filter((a) => a.forms.size > 0);
  if (anchors.length === 0) return groups;

  const isAnchor = new Set(anchors.map((a) => a.group));
  const kept: TokenGroup<T>[] = [];
  for (const tail of groups) {
    if (isAnchor.has(tail)) continue;
    const need = Math.ceil(tail.tokens.length * config.tailShare);
    const tokenForms = tail.tokens.map((t) => formsOf(t, config));
    const hits = anchors.filter((a) => tokenForms.filter((forms) => [...forms].some((f) => a.forms.has(f))).length >= need);
    if (hits.length === 1) (hits[0] as (typeof anchors)[number]).absorbed.push(tail);
    else kept.push(tail);
  }

  const out = [...kept];
  for (const a of anchors) out.push(a.absorbed.length === 0 ? a.group : { ...a.group, tokens: [...a.group.tokens, ...a.absorbed.flatMap((g) => g.tokens)] });
  out.sort((x, y) => y.tokens.length - x.tokens.length || cmpStr(x.key, y.key));
  return out;
}
