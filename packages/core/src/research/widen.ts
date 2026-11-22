import type { DexPair } from "../sources/dexscreener.ts";
import type { MigratedToken } from "../study/store.ts";
import { RESEARCH_CANDIDATES_MAX, RESEARCH_LITERAL_MAX } from "./brief.ts";
import { decideBonded, isCa } from "./picks.ts";

/**
 * Research widen (ticket 01): finds themed coins the literal DexScreener search misses, and merges them with its hits. Pure code, no network and no
 * model: `matchLocal` reads the tokens Argus saw migrate (the Study), `mergeCandidates` applies the bonded rule, the order and the cap.
 */

/** A term shorter than this is a stem: it matches only at a word boundary (see `termMatches`). */
const SHORT_TERM_CHARS = 4;
/** A stem found at the END of a word needs at least this many characters before it: "CATEMAS" is a blend, "Thomas" is a name. */
const BLEND_PREFIX_MIN = 4;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Whether `term` is in `text`, case-insensitively with runs of whitespace collapsed. A term of 4 or more characters matches anywhere. A shorter term (a
 * stem such as "mas") matches only a whole word, the start of a word ("GTA6"), or the end of a word that has at least 4 characters before the stem
 * ("CATEMAS", "Bullmas" but not "Thomas" or "Xmas"); never the middle of one. Words are runs of letters and digits. Linear in the text; no pattern is built
 * from the term.
 */
export function termMatches(term: string, text: string): boolean {
  const t = norm(term);
  if (t === "") return false;
  const x = norm(text);
  if (t.length >= SHORT_TERM_CHARS) return x.includes(t);
  for (const word of x.split(/[^\p{L}\p{N}]+/u)) {
    if (word.startsWith(t)) return true;
    if (word.endsWith(t) && word.length - t.length >= BLEND_PREFIX_MIN) return true;
  }
  return false;
}

export interface LocalMatch {
  token: MigratedToken;
  /** The first term of the list that matched, as it was given (trimmed). */
  via: string;
}

/**
 * The tokens of `tokens` that any of `terms` matches over the name, the ticker or the description (each field on its own, so a word never runs across two
 * fields). The order of `tokens` is kept; each token is listed once, with the first matching term of the list as its `via`.
 */
export function matchLocal(terms: readonly string[], tokens: readonly MigratedToken[]): LocalMatch[] {
  const clean = terms.map((t) => t.trim()).filter((t) => t !== "");
  if (clean.length === 0) return [];
  const out: LocalMatch[] = [];
  for (const token of tokens) {
    const fields = [token.name, token.symbol, token.description];
    const via = clean.find((term) => fields.some((f) => termMatches(term, f)));
    if (via !== undefined) out.push({ token, via });
  }
  return out;
}

// ---------------------------------------------------------------- the merge

const capOf = (p: DexPair): number => p.marketCapUsd ?? p.fdvUsd ?? -1;
const byCapThenLiquidity = (a: DexPair, b: DexPair): number => capOf(b) - capOf(a) || b.liquidityUsd - a.liquidityUsd;

/** Solana pairs with a price and a plain address, grouped per token: the deepest pair, and every pair of the token (the bonded rule reads them all). */
function groupByToken(pairs: readonly DexPair[]): Map<string, { deepest: DexPair; all: DexPair[] }> {
  const groups = new Map<string, { deepest: DexPair; all: DexPair[] }>();
  for (const p of pairs) {
    if (p.chainId !== "solana" || p.unpriced === true || !isCa(p.tokenAddress)) continue;
    const g = groups.get(p.tokenAddress);
    if (!g) groups.set(p.tokenAddress, { deepest: p, all: [p] });
    else {
      g.all.push(p);
      if (p.liquidityUsd > g.deepest.liquidityUsd) g.deepest = p;
    }
  }
  return groups;
}

/** The literal search's coins as they were offered before widening: one per token (its deepest pair), biggest cap first (unknown last), at most `RESEARCH_LITERAL_MAX`. */
export function topLiteral(pairs: readonly DexPair[]): DexPair[] {
  return [...groupByToken(pairs).values()].map((g) => g.deepest).sort(byCapThenLiquidity).slice(0, RESEARCH_LITERAL_MAX);
}

export interface MergedCandidate {
  /** `c1`, `c2`, ...: the only name the model has for the coin. */
  id: string;
  pair: DexPair;
  bonded: boolean;
  /** The term that found the coin (code-set; for a literal-search hit, the topic that was searched). */
  via: string;
}

export interface MergeInput {
  /** What the literal search for the topic returned. */
  topic: string;
  literal: readonly DexPair[];
  /** Pairs of the extra coins (the local set, later the term searches), each with the term that found it; several pairs of one coin are judged together. */
  extras: readonly { pair: DexPair; via: string }[];
  /** Argus's own migration record for a mint (`Datastore.migrationOf`). */
  migratedAt: (ca: string) => string | null;
}

/**
 * The candidates the model may choose from. Literal-search hits are kept as they always were (at most 15, bonded or not). An extra coin is kept only
 * when it is bonded: a local migration, else a graduation pool with at least `BONDED_MIN_LIQUIDITY_USD` (`decideBonded`). A coin the literal search
 * already found keeps its literal pair and `via`. Then bonded first, biggest market cap (unknown last), deepest liquidity, at most
 * `RESEARCH_CANDIDATES_MAX`, numbered `c1`...
 */
export function mergeCandidates(input: MergeInput): MergedCandidate[] {
  const literalGroups = groupByToken(input.literal);
  const merged: Omit<MergedCandidate, "id">[] = topLiteral(input.literal).map((pair) => ({
    pair,
    via: input.topic,
    bonded: decideBonded(pair.tokenAddress, literalGroups.get(pair.tokenAddress)?.all ?? [pair], input.migratedAt(pair.tokenAddress)).bonded,
  }));
  const have = new Set(merged.map((c) => c.pair.tokenAddress));
  const extraGroups = groupByToken(input.extras.map((e) => e.pair));
  const viaOf = new Map<string, string>();
  for (const e of input.extras) if (!viaOf.has(e.pair.tokenAddress)) viaOf.set(e.pair.tokenAddress, e.via);
  for (const [ca, g] of extraGroups) {
    if (have.has(ca)) continue;
    if (!decideBonded(ca, g.all, input.migratedAt(ca)).bonded) continue;
    merged.push({ pair: g.deepest, via: viaOf.get(ca) ?? input.topic, bonded: true });
  }
  return merged
    .sort((a, b) => Number(b.bonded) - Number(a.bonded) || byCapThenLiquidity(a.pair, b.pair))
    .slice(0, RESEARCH_CANDIDATES_MAX)
    .map((c, i) => ({ id: `c${i + 1}`, ...c }));
}
