import { checkDistinctName } from "../beta/distinct-name.ts";
import { metaMoney } from "../meta/summary.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import { cleanLine } from "./ideas.ts";

/**
 * The copy check's liveness test (meta redesign ticket 16): a token DexScreener lists makes an idea's name a copy only when the token is live,
 * by the same real-clone test the Moment scans use (moment scanner spec section 5): priced (not `unpriced`), liquidity at least $5,000, and a
 * market cap (the FDV when there is none) of at most 100 times the liquidity. A dead or drained token (the Boomazoom case: a $131K curve whose
 * pool held $4) does not refuse an idea; it becomes a note on the Proposal. Everything compared is creator-written text: no RegExp is built from it.
 */
export const LIVE_TOKEN_MIN_LIQUIDITY_USD = 5_000;
export const LIVE_TOKEN_MAX_CAP_LIQUIDITY_RATIO = 100;

/** The most dead tokens named in one idea's note. */
const NOTE_TOKENS_MAX = 2;
const NOTE_NAME_CHARS = 40;

/** Whether one DexScreener pair is a live market. A pair with no cap and no FDV cannot pass the ratio test, so it is not live. */
export function isLiveToken(p: Pick<DexPair, "liquidityUsd" | "marketCapUsd" | "fdvUsd" | "unpriced">): boolean {
  if (p.unpriced === true) return false;
  if (!(p.liquidityUsd >= LIVE_TOKEN_MIN_LIQUIDITY_USD)) return false;
  const cap = p.marketCapUsd ?? p.fdvUsd;
  return cap !== undefined && cap <= LIVE_TOKEN_MAX_CAP_LIQUIDITY_RATIO * p.liquidityUsd;
}

/**
 * What DexScreener's answer for one idea says: `live`, the display labels of the live tokens the idea copies (they refuse it), and `note`, one
 * line naming up to two dead tokens it copies (they do not): "name also used by a dead token: Dexter $2.9K". Only Solana pairs count. A
 * token is its pairs together (same address, name and ticker) and is live when any of its pairs is; its cap is that of its deepest pair.
 */
export function deadTokenNotes(idea: { name: string; ticker: string }, pairs: readonly DexPair[]): { live: string[]; note?: string } {
  const tokens = new Map<string, DexPair[]>();
  for (const p of pairs) {
    if (p.chainId !== "solana") continue;
    const key = `${p.tokenAddress}\n${p.name}\n${p.symbol}`;
    tokens.set(key, [...(tokens.get(key) ?? []), p]);
  }
  const live: string[] = [];
  const notes: string[] = [];
  for (const group of tokens.values()) {
    const first = group[0] as DexPair;
    const copy = checkDistinctName(idea, [{ name: first.name, symbol: first.symbol }]);
    if (copy.ok) continue;
    if (group.some(isLiveToken)) {
      for (const o of copy.offending) if (!live.includes(o)) live.push(o);
      continue;
    }
    if (notes.length >= NOTE_TOKENS_MAX) continue;
    const deepest = group.reduce((a, b) => (b.liquidityUsd > a.liquidityUsd ? b : a));
    const cap = deepest.marketCapUsd ?? deepest.fdvUsd;
    const what = copy.reason.startsWith("the ticker") ? "ticker" : "name";
    notes.push(`${what} also used by a dead token: ${cleanLine(first.name || first.symbol, NOTE_NAME_CHARS)}${cap !== undefined ? ` ${metaMoney(cap)}` : ""}`);
  }
  return { live, ...(notes.length > 0 ? { note: notes.join("; ") } : {}) };
}
