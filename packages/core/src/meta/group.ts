import { subjectKey } from "./key.ts";

/**
 * Clone clusters (ticket 03, slice 1): tokens that share a subject key are one group, found with a union-find over the keys, so
 * `米苏 ($MISU)` and `Misu ($Misu)` meet through `misu`. One key space for names and tickers: a token called Trump and another with the
 * ticker TRUMP are the same subject. Plain code over untrusted text; linear in the number of tokens.
 */

export interface GroupableToken {
  mint: string;
  name: string;
  symbol: string;
}

export interface TokenGroup<T extends GroupableToken> {
  /** The group's most frequent subject key (ties: the smaller), stable whatever the input order. `unkeyed:<mint>` for a token with no usable key. */
  key: string;
  /** The most frequent name, cleaned and cut for display. Still creator-written text: callers that show it in a prompt cap and fence it again. */
  label: string;
  tokens: T[];
}

export interface GroupOptions {
  /** A key tied to more than this many distinct other keys is a hub (too generic to say two tokens are the same subject) and merges nothing. */
  maxPartners?: number;
}

/**
 * Keys too generic to merge on: words every other token uses, the big chains and tickers, and the carrier themes the Operator does
 * not count as Metas (cat, dog; GLOSSARY and the ticket's open question 4). A single character is generic whatever it is.
 */
const GENERIC_WORDS = [
  "coin", "coins", "token", "tokens", "the", "a", "an", "of", "and", "ai", "sol", "solana", "btc", "bitcoin", "eth", "ethereum", "usdc", "usdt", "bnb",
  "pump", "pumpfun", "pump fun", "meme", "memes", "memecoin", "meme coin", "official", "test", "testing", "inu", "cat", "dog", "cats", "dogs", "new",
];
const GENERIC_KEYS: ReadonlySet<string> = new Set(GENERIC_WORDS);

/** True for a normalised key that never merges (stoplist or a single character). */
export function isGenericKey(key: string): boolean {
  return GENERIC_KEYS.has(key) || [...key].length < 2;
}

/**
 * Measured on the 2026-11-11 DB copy (29,272 launchpad creates over three days): the most partner keys any key had was 72 (the DacityCoin
 * spam name), then 34 (klaudia), 31, 25 (gta6) and 24; real clusters such as NIHAO and GTA6 sit in that range. So the cap sits well above
 * every key seen and exists only to stop a pathological key from fusing hundreds of unrelated tokens; on that data it never fires.
 */
export const DEFAULT_MAX_PARTNERS = 200;

const MAX_LABEL_CHARS = 60;
const NOT_DISPLAY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const WHITESPACE = /\s/u;

/** A name for display: control, format and bidi characters removed, whitespace flattened to one space, cut to 60 code points. */
export function cleanLabel(text: string): string {
  let out = "";
  let count = 0;
  let pendingSpace = false;
  for (const ch of text.slice(0, 2_000)) {
    if (NOT_DISPLAY.test(ch)) {
      if (ch === "\n" || ch === "\r" || ch === "\t" || ch === " " || ch === " ") pendingSpace = true;
      continue;
    }
    if (WHITESPACE.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out !== "") {
      out += " ";
      count++;
    }
    pendingSpace = false;
    if (count >= MAX_LABEL_CHARS) break;
    out += ch;
    count++;
  }
  return out;
}

class UnionFind {
  private readonly parent: number[] = [];
  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r] as number;
    while (this.parent[x] !== r) {
      const next = this.parent[x] as number;
      this.parent[x] = r;
      x = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The key or name with the highest count; ties go to the smaller string, so the answer does not depend on input order. */
function mostFrequent(counts: Map<string, number>): string {
  let best = "";
  let bestN = -1;
  for (const [k, n] of counts) if (n > bestN || (n === bestN && cmpStr(k, best) < 0)) [best, bestN] = [k, n];
  return best;
}

/** Groups tokens that share a non-generic subject key. Biggest group first, then by key. Tokens with no usable key are groups of one. */
export function groupTokens<T extends GroupableToken>(tokens: readonly T[], opts: GroupOptions = {}): TokenGroup<T>[] {
  const maxPartners = opts.maxPartners ?? DEFAULT_MAX_PARTNERS;
  const keysOf = tokens.map((t) => subjectKey(t.name, t.symbol).filter((k) => !isGenericKey(k)));

  // A hub key (tied to very many distinct other keys) is dropped before any merging.
  const partners = new Map<string, Set<string>>();
  for (const ks of keysOf) {
    if (ks.length < 2) continue;
    for (const k of ks) {
      let set = partners.get(k);
      if (!set) partners.set(k, (set = new Set()));
      for (const other of ks) if (other !== k) set.add(other);
    }
  }
  const hubs = new Set<string>();
  for (const [k, set] of partners) if (set.size > maxPartners) hubs.add(k);

  const uf = new UnionFind();
  const index = new Map<string, number>();
  const usable = keysOf.map((ks) => ks.filter((k) => !hubs.has(k)));
  for (const ks of usable) {
    let first = -1;
    for (const k of ks) {
      let i = index.get(k);
      if (i === undefined) index.set(k, (i = uf.add()));
      if (first < 0) first = i;
      else uf.union(first, i);
    }
  }

  interface Acc {
    tokens: T[];
    keys: Map<string, number>;
    names: Map<string, number>;
    symbols: Map<string, number>;
  }
  const acc = new Map<string, Acc>();
  tokens.forEach((t, i) => {
    const ks = usable[i] as string[];
    const gid = ks.length > 0 ? `k${uf.find(index.get(ks[0] as string) as number)}` : `u${i}`;
    let a = acc.get(gid);
    if (!a) acc.set(gid, (a = { tokens: [], keys: new Map(), names: new Map(), symbols: new Map() }));
    a.tokens.push(t);
    for (const k of ks) a.keys.set(k, (a.keys.get(k) ?? 0) + 1);
    const name = cleanLabel(t.name);
    if (name !== "") a.names.set(name, (a.names.get(name) ?? 0) + 1);
    const symbol = cleanLabel(t.symbol);
    if (symbol !== "") a.symbols.set(symbol, (a.symbols.get(symbol) ?? 0) + 1);
  });

  const groups: TokenGroup<T>[] = [];
  for (const a of acc.values()) {
    const key = a.keys.size > 0 ? mostFrequent(a.keys) : `unkeyed:${(a.tokens[0] as T).mint}`;
    const label = a.names.size > 0 ? mostFrequent(a.names) : mostFrequent(a.symbols);
    groups.push({ key, label, tokens: a.tokens });
  }
  groups.sort((x, y) => y.tokens.length - x.tokens.length || cmpStr(x.key, y.key));
  return groups;
}
