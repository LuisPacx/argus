import { aliasKey, normaliseKey, subjectKey } from "./key.ts";

/**
 * Clone clusters (ticket 03, slice 1): tokens that share a subject key are one group, found with a union-find over the keys, so
 * `米苏 ($MISU)` and `Misu ($Misu)` meet through `misu`. One key space for names and tickers: a token called Trump and another with the
 * ticker TRUMP are the same subject. Plain code over untrusted text; linear in the number of tokens.
 *
 * Meta redesign ticket 06 (ADR 0015, decision 4): keys meet through their strict alias form (`aliasKey`: `gta 6`, `gta6`, `gta vi` and `gtavi`
 * are one), and a group is named by what the most distinct creators used, not the most tokens (one creator's 44 mints no longer name it).
 */

export interface GroupableToken {
  mint: string;
  name: string;
  symbol: string;
  /** The wallet that launched the token. Absent or empty counts as a creator of its own, so a token with no creator casts one vote. */
  creator?: string;
}

export interface TokenGroup<T extends GroupableToken> {
  /** The key used by the most distinct creators (then the most tokens, then the smaller string), stable whatever the input order. `unkeyed:<mint>` for a token with no usable key. */
  key: string;
  /** The name used by the most distinct creators, cleaned and cut for display. Still creator-written text: callers that show it in a prompt cap and fence it again. */
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

/** One candidate key or name in a vote: the creators that used it (a token with no creator is a creator of its own) and how many tokens carry it. */
interface Tally {
  creators: Set<string>;
  tokens: number;
}

/** The creator a token counts as in a vote. An empty or missing creator is distinct per mint, so it never merges with another token's. */
const voterOf = (t: GroupableToken): string => (t.creator !== undefined && t.creator !== "" ? t.creator : `\u0000${t.mint}`);

function cast(votes: Map<string, Tally>, value: string, voter: string): void {
  let tally = votes.get(value);
  if (!tally) votes.set(value, (tally = { creators: new Set(), tokens: 0 }));
  tally.creators.add(voter);
  tally.tokens++;
}

/** The winner of a vote: most distinct creators, then most tokens, then the smaller string, so the answer does not depend on input order. Undefined for an empty vote. */
function winner(votes: Map<string, Tally>): string | undefined {
  let best: string | undefined;
  let bestTally: Tally | undefined;
  for (const [value, tally] of votes) {
    const better =
      bestTally === undefined ||
      tally.creators.size > bestTally.creators.size ||
      (tally.creators.size === bestTally.creators.size && (tally.tokens > bestTally.tokens || (tally.tokens === bestTally.tokens && cmpStr(value, best as string) < 0)));
    if (better) [best, bestTally] = [value, tally];
  }
  return best;
}

/**
 * Names a group of tokens by creator weight (ADR 0015, decision 4). `keysOf` says which keys each token votes for (a creator counts once per
 * key and once per name, however many tokens of theirs carry it). Spelling aliases are one key (`aliasKey`): the vote is among alias forms, by the
 * distinct creators who used any spelling of one (a creator who wrote both `gta6` and `gta vi` counts once), and the key is the most used original
 * spelling of the winning form, so `gta6` beats `gta` when more creators wrote some spelling of GTA 6 than wrote plain GTA. The label is the most
 * used cleaned name whose own key is in the winning form (so label and key agree), else the most used name, else the most used ticker. Returns
 * the key (undefined when no token has a usable key) and the label. `mergeThemes` calls it again over a merged group's tokens.
 */
export function nameGroup<T extends GroupableToken>(tokens: readonly T[], keysOf: (t: T) => readonly string[]): { key: string | undefined; label: string } {
  const forms = new Map<string, Tally>();
  const spellings = new Map<string, Map<string, Tally>>();
  const names = new Map<string, Tally>();
  const namesOfForm = new Map<string, Map<string, Tally>>();
  const symbols = new Map<string, Tally>();
  for (const t of tokens) {
    const voter = voterOf(t);
    const seenForms = new Set<string>();
    for (const k of keysOf(t)) {
      const form = aliasKey(k);
      // A token whose name and ticker are two spellings of one form is one vote for the form, but each spelling still counts for itself.
      if (!seenForms.has(form)) cast(forms, form, voter);
      seenForms.add(form);
      let own = spellings.get(form);
      if (!own) spellings.set(form, (own = new Map()));
      cast(own, k, voter);
    }
    const name = cleanLabel(t.name);
    if (name !== "") {
      cast(names, name, voter);
      // The name also votes inside the form its own key belongs to, so the label can agree with the key.
      const nameForm = aliasKey(normaliseKey(t.name));
      let own = namesOfForm.get(nameForm);
      if (!own) namesOfForm.set(nameForm, (own = new Map()));
      cast(own, name, voter);
    }
    const symbol = cleanLabel(t.symbol);
    if (symbol !== "") cast(symbols, symbol, voter);
  }
  const form = winner(forms);
  const label = (form === undefined ? undefined : winner(namesOfForm.get(form) ?? new Map())) ?? winner(names) ?? winner(symbols) ?? "";
  return { key: form === undefined ? undefined : winner(spellings.get(form) as Map<string, Tally>), label };
}

/** The non-generic keys of one token: what it votes for and what joins it to others. */
export const tokenKeys = (t: GroupableToken): string[] => subjectKey(t.name, t.symbol).filter((k) => !isGenericKey(k));

/**
 * Groups tokens that share a non-generic subject key, or keys that differ only by spelling aliases (`aliasKey`). Biggest group first, then by
 * key. Tokens with no usable key are groups of one. The group's key and label are the ones most distinct creators used (`nameGroup`).
 */
export function groupTokens<T extends GroupableToken>(tokens: readonly T[], opts: GroupOptions = {}): TokenGroup<T>[] {
  const maxPartners = opts.maxPartners ?? DEFAULT_MAX_PARTNERS;
  const keysOf = tokens.map(tokenKeys);
  // The alias form of each key (computed once per key): what keys meet through, and what a hub is counted on.
  const alias = new Map<string, string>();
  const aliasOf = (k: string): string => {
    let a = alias.get(k);
    if (a === undefined) alias.set(k, (a = aliasKey(k)));
    return a;
  };
  const aliasesOf = keysOf.map((ks) => [...new Set(ks.map(aliasOf))]);

  // A hub key (tied to very many distinct other keys) is dropped before any merging.
  const partners = new Map<string, Set<string>>();
  for (const ks of aliasesOf) {
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
  const usable = aliasesOf.map((ks) => ks.filter((k) => !hubs.has(k)));
  for (const ks of usable) {
    let first = -1;
    for (const k of ks) {
      let i = index.get(k);
      if (i === undefined) index.set(k, (i = uf.add()));
      if (first < 0) first = i;
      else uf.union(first, i);
    }
  }

  const acc = new Map<string, T[]>();
  tokens.forEach((t, i) => {
    const ks = usable[i] as string[];
    const gid = ks.length > 0 ? `k${uf.find(index.get(ks[0] as string) as number)}` : `u${i}`;
    const list = acc.get(gid);
    if (list) list.push(t);
    else acc.set(gid, [t]);
  });

  const groups: TokenGroup<T>[] = [];
  const keyOf = new Map<T, string[]>(tokens.map((t, i) => [t, keysOf[i] as string[]]));
  for (const list of acc.values()) {
    // A token votes for its original spellings, except those whose alias form is a hub (they were never used to join anything).
    const named = nameGroup(list, (t) => (keyOf.get(t) as string[]).filter((k) => !hubs.has(aliasOf(k))));
    groups.push({ key: named.key ?? `unkeyed:${(list[0] as T).mint}`, label: named.label, tokens: list });
  }
  groups.sort((x, y) => y.tokens.length - x.tokens.length || cmpStr(x.key, y.key));
  return groups;
}
