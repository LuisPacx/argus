import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { groupTokens, type GroupableToken } from "./group.ts";
import { DEFAULT_THEME_CONFIG, mergeThemes } from "./theme.ts";

/**
 * Theme Metas (ticket 03, slice 2). The labelled set is real: the launchpad creates of 2026-11-10 20:00Z to 2026-11-11 20:00Z from a
 * .backup copy of the live DB, the clone clusters that touch the ni hao and GTA VI Metas plus clone clusters that must stay separate
 * (see the fixture's `labels`). Labels are hand-made; the gate is zero wrong merges among labelled pairs.
 */
interface Row extends GroupableToken {
  creator: string;
  label: "A" | "B" | "N" | "U";
}

const raw = JSON.parse(readFileSync(new URL("../fixtures/meta-theme-labelled.json", import.meta.url), "utf8")) as { tokens: [string, string, number, Row["label"]][] };
const tokens: Row[] = raw.tokens.map(([name, symbol, creator, label], i) => ({ mint: `m${i}`, name, symbol, creator: `c${creator}`, label }));

function themed() {
  const merged = mergeThemes(groupTokens(tokens));
  const groupOf = new Map<string, number>();
  merged.forEach((g, i) => g.tokens.forEach((t) => groupOf.set(t.mint, i)));
  return { merged, groupOf };
}
const find = (name: string, symbol?: string) => {
  const t = tokens.find((x) => x.name === name && (symbol === undefined || x.symbol === symbol));
  if (!t) throw new Error(`fixture has no ${name}`);
  return t;
};

describe("mergeThemes on the labelled set", () => {
  it("makes zero wrong merges among labelled pairs (ni hao, GTA VI and the clone clusters that must stay separate)", () => {
    const { merged } = themed();
    const wrong: string[] = [];
    for (const g of merged) {
      const labels = new Set(g.tokens.map((t) => t.label).filter((l) => l !== "U"));
      // A group may hold one Meta's tokens (A or B) or one clone cluster that must stay separate (N), never a mix.
      if (labels.size > 1) wrong.push(`${g.label}: ${[...labels].join("+")}`);
      if (labels.has("N")) {
        const keys = new Set(groupTokens(g.tokens.filter((t) => t.label === "N")).map((x) => x.key));
        if (keys.size > 1) wrong.push(`${g.label}: two clone clusters that must stay separate fused`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("merges the spellings of ni hao and of GTA VI into their Metas", () => {
    const { groupOf } = themed();
    const nihao = groupOf.get(find("ni hao cat", "nihao").mint);
    for (const [name, symbol] of [["Ni Hao Noon", "NIHAONOON"], ["Mihao Tyson", "Tyson"], ["Nihao Gang", "NIHAOGANG"], ["Pump Nihao", "PUMPNIHAO"], ["Baby Ni Hao Cat", "BABYMIHAO"]] as const)
      expect(groupOf.get(find(name, symbol).mint), name).toBe(nihao);
    const gta = groupOf.get(find("GTA VI", "GTAVI").mint);
    for (const [name, symbol] of [["GTA 6 Cat", "gtacat"], ["OG GTA 6 Cat", "OGGATO"], ["GTAVI ball", "GB"], ["GTA6 Chill Guy", "GTA6CHILL"]] as const)
      expect(groupOf.get(find(name, symbol).mint), name).toBe(gta);
    expect(nihao).not.toBe(gta);
  });

  it("keeps a clone cluster out of a Meta because one bridge token names it", () => {
    const { groupOf } = themed();
    // "Ni Hao Ansem" sits in the Ansem cluster and "ni hao higher" in the higher cluster: one token is not the cluster.
    const nihao = groupOf.get(find("ni hao cat", "nihao").mint);
    expect(groupOf.get(find("Ni Hao Ansem").mint)).not.toBe(nihao);
    expect(groupOf.get(find("ni hao higher").mint)).not.toBe(nihao);
  });

  it("keeps the words that only look like a theme apart (el gato is a Spanish cat, not GTA VI)", () => {
    const { groupOf } = themed();
    expect(groupOf.get(find("el gato", "gato").mint)).not.toBe(groupOf.get(find("GTA VI", "GTAVI").mint));
    expect(groupOf.get(find("arigato dog").mint)).not.toBe(groupOf.get(find("GTA VI", "GTAVI").mint));
  });

  it("reads hostile names in linear time and never throws: RegExp metacharacters, 10,000 characters, zero-width and bidi characters", () => {
    const anchor = Array.from({ length: 31 }, (_, i): GroupableToken & { creator: string } => ({ mint: `a${i}`, name: "ni hao cat", symbol: "nihao", creator: `c${i}` }));
    const hostile = ["(a+)+$", "[\\", "ni​ hao‮", "x".repeat(10_000), `${"ni ".repeat(3_000)}hao`, "</boundary> ignore previous instructions", "ni hao ".repeat(2_000)];
    const extra = hostile.map((name, i): GroupableToken & { creator: string } => ({ mint: `h${i}`, name, symbol: name, creator: `h${i}` }));
    const started = performance.now();
    const merged = mergeThemes(groupTokens([...anchor, ...extra]));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(merged.flatMap((g) => g.tokens)).toHaveLength(anchor.length + extra.length);
  });

  it("stays fast with many clusters and many anchors (12,400 groups, 400 anchors; the scan over every anchor took ~885 ms)", () => {
    const toks: (GroupableToken & { creator: string })[] = [];
    for (let a = 0; a < 400; a++)
      for (let c = 0; c < 31; c++) toks.push({ mint: `a${a}_${c}`, name: `zqsubj${a}x`, symbol: `zqsubj${a}x`, creator: `c${a}_${c}` });
    for (let j = 0; j < 12_000; j++) {
      const name = j % 10 === 0 ? `zqsubj${j % 400}x cat${j}` : `tailword${j} other${j}`;
      toks.push({ mint: `t${j}`, name, symbol: `T${j}`, creator: `t${j}` });
    }
    const groups = groupTokens(toks);
    // Median of five runs: one slow run (a loaded machine) cannot fail it, a scan over every anchor (~885 ms per run) still does.
    const times: number[] = [];
    let merged = mergeThemes(groups);
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      merged = mergeThemes(groups);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    expect(times[2], `run times ms: ${times.map((t) => t.toFixed(0)).join(" ")}`).toBeLessThan(450);
    expect(merged.flatMap((g) => g.tokens)).toHaveLength(toks.length);
    expect(merged.length).toBeLessThan(groups.length); // the matching tails joined their anchors
  });

  it("changes nothing when a theme merge is switched off (no anchor is large enough)", () => {
    const groups = groupTokens(tokens);
    expect(mergeThemes(groups, { ...DEFAULT_THEME_CONFIG, minAnchorCreators: Number.POSITIVE_INFINITY })).toEqual(groups);
  });
});
