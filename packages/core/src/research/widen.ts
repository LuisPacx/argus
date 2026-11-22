import type { DexPair } from "../sources/dexscreener.ts";
import type { MigratedToken } from "../study/store.ts";
import { matchesField, norm, prepare, SHORT_TERM_CHARS, termMatches } from "../term-match.ts";
import { RESEARCH_CANDIDATES_MAX, RESEARCH_LITERAL_MAX } from "./brief.ts";
import { decideBonded, isCa, LAUNCHPAD_MINT_SUFFIX } from "./picks.ts";

/**
 * Research widen (ticket 01): finds themed coins the literal DexScreener search misses, and merges them with its hits. Pure code, no network and no
 * model: `matchLocal` reads the tokens Argus saw migrate (the Study), `mergeCandidates` applies the bonded rule, the order and the cap.
 */

/** The matching rule lives in `../term-match.ts`, shared with the Meta blend pass; re-exported here so widen's public surface is unchanged. */
export { termMatches };

export interface LocalMatch {
  token: MigratedToken;
  /** The first term of the list that matched, as it was given (trimmed). */
  via: string;
}

/**
 * The tokens of `tokens` that any of `terms` matches over the name, the ticker or the description (each field on its own, so a word never runs across two
 * fields). A term under 4 characters is looked for in the name and the ticker only: in free text such a stem hits too much ("mas" in "master", "massive").
 * The order of `tokens` is kept; each token is listed once, with the first matching term of the list as its `via`. Each field is normalised and split into
 * words once per token, not once per term.
 */
export function matchLocal(terms: readonly string[], tokens: readonly MigratedToken[]): LocalMatch[] {
  const clean = terms.map((t) => ({ via: t.trim(), t: norm(t) })).filter((c) => c.t !== "");
  if (clean.length === 0) return [];
  const anyShort = clean.some((c) => c.t.length < SHORT_TERM_CHARS);
  const out: LocalMatch[] = [];
  for (const token of tokens) {
    const names = [prepare(token.name, anyShort), prepare(token.symbol, anyShort)];
    // The field lists are built once per token, not once per term: with up to 15 terms over a week of migrations the per-term cost is one `includes` or word scan.
    const withDescription = [...names, prepare(token.description, false)];
    const hit = clean.find((c) => (c.t.length < SHORT_TERM_CHARS ? names : withDescription).some((f) => matchesField(c.t, f)));
    if (hit !== undefined) out.push({ token, via: hit.via });
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
  /** true: bonded; false: shown not to be; null: argus has no basis (see `bondedState`). */
  bonded: boolean | null;
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

/** Literal hits that always stay in the candidates (the biggest caps), however many bonded extras there are. */
export const RESEARCH_LITERAL_RESERVED = 5;

/**
 * Whether the coin has bonded: true by `decideBonded` (a local migration, else a graduation pool with at least `BONDED_MIN_LIQUIDITY_USD` on a launchpad
 * mint); false when its pairs show where it trades and that is no graduation pool; null when argus has no basis either way (not a launchpad mint, or no
 * pair names its venue), so the prompt says "unknown" rather than claim "not bonded".
 */
function bondedState(ca: string, pairs: readonly DexPair[], migratedAt: string | null): boolean | null {
  if (decideBonded(ca, pairs, migratedAt).bonded) return true;
  if (!ca.endsWith(LAUNCHPAD_MINT_SUFFIX) || pairs.every((p) => p.dexId === undefined)) return null;
  return false;
}

/**
 * The candidates the model may choose from. Literal-search hits are kept as they always were (at most 15, bonded or not). An extra coin is kept only
 * when it is bonded (`bondedState`). A coin the literal search already found keeps its literal pair and `via`. The best `RESEARCH_LITERAL_RESERVED`
 * literal hits by market cap always stay; the rest of the `RESEARCH_CANDIDATES_MAX` slots go to the best of everything else (bonded first, then market
 * cap, then liquidity). Shown bonded first, biggest market cap (unknown last), deepest liquidity, numbered `c1`...
 */
export function mergeCandidates(input: MergeInput): MergedCandidate[] {
  const literalGroups = groupByToken(input.literal);
  const literal: Omit<MergedCandidate, "id">[] = topLiteral(input.literal).map((pair) => ({
    pair,
    via: input.topic,
    bonded: bondedState(pair.tokenAddress, literalGroups.get(pair.tokenAddress)?.all ?? [pair], input.migratedAt(pair.tokenAddress)),
  }));
  const have = new Set(literal.map((c) => c.pair.tokenAddress));
  const extraGroups = groupByToken(input.extras.map((e) => e.pair));
  const viaOf = new Map<string, string>();
  for (const e of input.extras) if (!viaOf.has(e.pair.tokenAddress)) viaOf.set(e.pair.tokenAddress, e.via);
  const extras: Omit<MergedCandidate, "id">[] = [];
  for (const [ca, g] of extraGroups) {
    if (have.has(ca)) continue;
    if (bondedState(ca, g.all, input.migratedAt(ca)) !== true) continue;
    extras.push({ pair: g.deepest, via: viaOf.get(ca) ?? input.topic, bonded: true });
  }
  const display = (a: Omit<MergedCandidate, "id">, b: Omit<MergedCandidate, "id">): number => Number(b.bonded === true) - Number(a.bonded === true) || byCapThenLiquidity(a.pair, b.pair);
  const reserved = literal.slice(0, Math.min(literal.length, RESEARCH_LITERAL_RESERVED));
  const rest = [...literal.slice(reserved.length), ...extras].sort(display).slice(0, RESEARCH_CANDIDATES_MAX - reserved.length);
  return [...reserved, ...rest].sort(display).map((c, i) => ({ id: `c${i + 1}`, ...c }));
}
