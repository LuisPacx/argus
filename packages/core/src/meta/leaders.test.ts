import { describe, expect, it } from "vitest";
import { META_RULE } from "./config.ts";
import { carriedState, currentMetas, type LeaderGraduate, type LeaderSubject, type LeaderToken, type PreviousMetas } from "./leaders.ts";
import type { CurrentGrads, CurrentMeta, MetaCounts } from "./store.ts";

const NOW = new Date("2026-11-15T15:35:00.000Z");
const config = META_RULE;

const counts = (creators: number): Record<"6h" | "24h", MetaCounts> => ({
  "6h": { tokens: creators, creators: Math.ceil(creators / 2), migrations: 0, migrationsAfter60s: 0 },
  "24h": { tokens: creators * 2, creators, migrations: 1, migrationsAfter60s: 1 },
});

const grads = (g24: number, g6 = Math.min(g24, 4), creators24h = g24): CurrentGrads => ({ "24h": g24, "6h": g6, creators24h, share: 0.1 });

const mintOf = (n: string) => `${n}`.padEnd(40, "x") + "pump";

/**
 * A subject: `key` is the group key, `names` are the names of its tokens, `g` its graduations (a Meta with 12 in 24 h from 12 creators, 4 in 6 h, by
 * default). It has one graduate (named after the key), so a Meta with no priced token has a leader to show.
 */
const subject = (key: string, g: CurrentGrads | number = 12, names: string[] = [key], over: Partial<LeaderSubject> = {}): LeaderSubject => ({
  key,
  label: key,
  counts: counts(typeof g === "number" ? g : g["24h"]),
  topTokens: [],
  tokens: names.map((name) => ({ name, symbol: name.toUpperCase().slice(0, 8) })),
  grads: typeof g === "number" ? grads(g) : g,
  graduates: [{ mint: mintOf(`grad-${key}`.slice(0, 30)), name: `Grad ${key}`.slice(0, 40), symbol: "GRAD", migratedAt: new Date(NOW.getTime() - 45 * 60_000).toISOString() }],
  ...over,
});
const token = (n: string, name: string, symbol: string, marketCapUsd: number, over: Partial<LeaderToken> = {}): LeaderToken => ({
  mint: mintOf(n),
  name,
  symbol,
  marketCapUsd,
  source: "trending",
  stale: false,
  freshAt: NOW.toISOString(),
  ...over,
});
const graduate = (n: string, name: string, symbol: string, minutesAgo: number): LeaderGraduate => ({ mint: mintOf(n), name, symbol, migratedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString() });

const run = (over: { subjects: LeaderSubject[]; tokens?: LeaderToken[]; previous?: PreviousMetas; grouped?: ReadonlySet<string>; now?: Date; config?: typeof config }) => currentMetas({ now: NOW, config, tokens: [], ...over });
const keys = (rows: CurrentMeta[]) => rows.map((r) => r.key);

/** A stored previous row for a subject whose leader was `lead`. */
const prevRow = (key: string, lead: LeaderToken, over: Partial<CurrentMeta> = {}): CurrentMeta => ({
  key,
  label: key,
  leader: { mint: lead.mint, name: lead.name, symbol: lead.symbol, marketCapUsd: lead.marketCapUsd, source: lead.source, stale: false, freshAt: "2026-11-15T15:20:00.000Z" },
  holding: false,
  enteredAt: "2026-11-15T09:00:00.000Z",
  counts: counts(12),
  topTokens: [],
  ...over,
});
const previousAt = (minutesAgo: number, metas: CurrentMeta[], watching: CurrentMeta[] = []): PreviousMetas => ({
  computedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  metas,
  watching,
});

describe("currentMetas: who is a Meta and who is Watching (graduations, not market cap)", () => {
  const jensen = (g: CurrentGrads | number) => subject("jensen", g, ["Jensen Huang", "Jensen", "Stand with Jensen"], { graduates: [graduate("g1", "Jensen Huang", "JENSEN", 30), graduate("g2", "Jensen", "JEN", 90)] });

  it("10 graduations from 6 creators with 3 in the last 6 h is a Meta with no priced token: the latest graduate leads, its cap a dash", () => {
    const r = run({ subjects: [jensen(grads(10, 3, 6))] });
    expect(keys(r.metas)).toEqual(["jensen"]);
    expect(r.metas[0]).toMatchObject({ holding: false, enteredAt: NOW.toISOString(), leader: { mint: mintOf("g1"), symbol: "JENSEN", marketCapUsd: 0, source: "theme", stale: false, freshAt: NOW.toISOString() }, grads: grads(10, 3, 6) });
    expect(r.watching).toEqual([]);
  });

  it("9 graduations are Watching, not a Meta", () => {
    const r = run({ subjects: [jensen(grads(9, 3, 9))] });
    expect(r.metas).toEqual([]);
    expect(keys(r.watching)).toEqual(["jensen"]);
  });

  it("10 graduations by one creator are not a Meta (Watching), and neither are 10 from 6 creators with only 2 in the last 6 h", () => {
    const one = run({ subjects: [jensen(grads(10, 3, 1))] });
    expect(one.metas).toEqual([]);
    expect(keys(one.watching)).toEqual(["jensen"]);
    const old = run({ subjects: [jensen(grads(10, 2, 6))] });
    expect(old.metas).toEqual([]);
    expect(keys(old.watching)).toEqual(["jensen"]);
  });

  it("a market cap changes nothing: a $96k leader and a $2.1M leader both lead a Meta, and neither makes one for a subject below the rule", () => {
    const small = run({ subjects: [jensen(12)], tokens: [token("j", "Jensen Huang", "JENSEN", 96_000)] });
    expect(small.metas[0]).toMatchObject({ key: "jensen", leader: { symbol: "JENSEN", marketCapUsd: 96_000, stale: false } });
    const big = run({ subjects: [jensen(12)], tokens: [token("j", "Jensen Huang", "JENSEN", 2_100_000)] });
    expect(big.metas[0]).toMatchObject({ key: "jensen", leader: { marketCapUsd: 2_100_000 } });
    const few = run({ subjects: [jensen(grads(4, 1, 4))], tokens: [token("j", "Jensen Huang", "JENSEN", 2_100_000)] });
    expect(few).toEqual({ metas: [], watching: [] });
  });

  it("a Meta stays at 5 graduations (holding, with its entry time) and drops at 4; below 5 it is Watching only with 3 in the last 6 h", () => {
    const before = prevRow("jensen", token("j", "Jensen Huang", "JENSEN", 1_300_000));
    const at5 = run({ subjects: [jensen(grads(5, 1, 3))], previous: previousAt(15, [before]) });
    expect(at5.metas[0]).toMatchObject({ key: "jensen", holding: true, enteredAt: "2026-11-15T09:00:00.000Z" });
    expect(at5.watching).toEqual([]);

    const at4 = run({ subjects: [jensen(grads(4, 1, 3))], previous: previousAt(15, [before]) });
    expect(at4).toEqual({ metas: [], watching: [] });
    const at4Live = run({ subjects: [jensen(grads(4, 3, 3))], previous: previousAt(15, [before]) });
    expect(at4Live.metas).toEqual([]);
    expect(at4Live.watching[0]).toMatchObject({ key: "jensen", holding: false, enteredAt: NOW.toISOString() });
  });

  it("a subject at 5 graduations that was not a Meta last run is only Watching, and a Meta that meets the enter rule again is not holding", () => {
    const never = run({ subjects: [jensen(grads(7, 1, 6))], previous: previousAt(15, []) });
    expect(never.metas).toEqual([]);
    expect(keys(never.watching)).toEqual(["jensen"]);
    const again = run({ subjects: [jensen(grads(10, 3, 6))], previous: previousAt(15, [prevRow("jensen", token("j", "Jensen Huang", "JENSEN", 900_000))]) });
    expect(again.metas[0]).toMatchObject({ holding: false, enteredAt: "2026-11-15T09:00:00.000Z" });
  });

  it("the state is carried for stateMaxMinutes: a Meta at 5 graduations stays after 120 minutes, and is a new subject after 121", () => {
    const row = prevRow("jensen", token("j", "Jensen Huang", "JENSEN", 1_300_000));
    const within = run({ subjects: [jensen(grads(5, 1, 3))], previous: previousAt(config.stateMaxMinutes, [row]) });
    expect(keys(within.metas)).toEqual(["jensen"]);
    const paused = run({ subjects: [jensen(grads(5, 1, 3))], previous: previousAt(config.stateMaxMinutes + 1, [row]) });
    expect(paused.metas).toEqual([]);
    expect(keys(paused.watching)).toEqual(["jensen"]);
  });

  it("at most 3 Metas, most graduations in 24 h first, then in 6 h, then creators; the fourth is Watching", () => {
    const subjects = [subject("alpha", grads(14, 3, 10)), subject("bravo", grads(12, 5, 12)), subject("charlie", grads(12, 4, 12)), subject("delta", grads(12, 4, 9)), subject("echo", grads(12, 3, 8))];
    const r = run({ subjects });
    expect(keys(r.metas)).toEqual(["alpha", "bravo", "charlie"]);
    expect(keys(r.watching)).toEqual(["delta", "echo"]);
  });

  it("Watching holds the top 3 by graduations in 6 h, then 24 h, and never a Meta", () => {
    const subjects = [subject("alpha", grads(12, 4, 12)), subject("bravo", grads(6, 2, 6)), subject("charlie", grads(5, 4, 5)), subject("delta", grads(8, 3, 8)), subject("echo", grads(5, 1, 5)), subject("foxtrot", grads(4, 2, 4))];
    const r = run({ subjects });
    expect(keys(r.metas)).toEqual(["alpha"]);
    expect(keys(r.watching)).toEqual(["charlie", "delta", "bravo"]); // 6 h: 4, 3, 2; echo (1 in 6 h) and foxtrot (4 in 24 h) are under a rule
  });

  it("the knobs move the rule: 12 graduations, 8 creators, one Meta, no Watching", () => {
    const subjects = [subject("alpha", grads(11, 4, 11)), subject("bravo", grads(13, 4, 7)), subject("charlie", grads(13, 4, 13)), subject("delta", grads(13, 4, 13))];
    const r = currentMetas({ subjects, tokens: [], now: NOW, config: { ...config, metaMinGrads: 12, metaMinCreators: 8, maxMetas: 1, watching: 0 } });
    expect(keys(r.metas)).toEqual(["charlie"]); // 13 graduations, 13 creators; delta ties it and loses on the key
    expect(r.watching).toEqual([]);
  });

  it("a theme's own token needs no name match (groupKey), and the highest-priced token leads", () => {
    const s = subject("gta6", 40, ["GTA 6 Cat", "GTA VI"]);
    const r = run({ subjects: [s], tokens: [token("a", "Mi", "M", 1_100_000, { source: "theme", groupKey: "gta6" }), token("b", "Whatever", "W", 400_000, { source: "theme", groupKey: "gta6" })] });
    expect(r.metas[0]).toMatchObject({ key: "gta6", leader: { symbol: "M", source: "theme" } });
  });

  it("a graduate of the subject that has a price leads it, whatever its name, and beats the latest unpriced graduate", () => {
    const s = subject("santa", 12, ["Santa"], { graduates: [graduate("late", "Late One", "LATE", 5), graduate("old", "Odd Name", "ODD", 600)] });
    const r = run({ subjects: [s], tokens: [token("old", "Odd Name", "ODD", 250_000)] });
    expect(r.metas[0]!.leader).toMatchObject({ mint: mintOf("old"), marketCapUsd: 250_000 });
    const none = run({ subjects: [s] });
    expect(none.metas[0]!.leader).toMatchObject({ mint: mintOf("late"), marketCapUsd: 0 });
  });

  it("a trending token never makes a Meta: it leads only a subject that has the graduations", () => {
    const trending = token("t", "Jensen Huang", "JENSEN", 90_000_000);
    expect(run({ subjects: [jensen(grads(3, 1, 3))], tokens: [trending] })).toEqual({ metas: [], watching: [] });
    expect(run({ subjects: [jensen(12)], tokens: [trending] }).metas[0]!.leader).toMatchObject({ mint: trending.mint, marketCapUsd: 90_000_000 });
  });
});

describe("currentMetas: replay of run 143 under the graduation rule", () => {
  // Run 143: the Jensen token led at $96k with 12 copy creators, and no leader reached $250k. Market cap no longer decides: Jensen is a Meta only when
  // 10 or more tokens graduated on it; the big launch themes that had no graduations (ni hao, gta6) are neither Meta nor Watching.
  const jensenWave = subject("jensen", grads(12, 4, 12), ["Jensen Huang", "Jensen", "Stand with Jensen", "Jensen Coin"]);
  const others = [subject("ni hao", grads(0, 0, 0), ["Ni Hao Cat", "Mi Hao"]), subject("gta6", grads(2, 0, 2), ["GTA 6 Cat", "GTA VI"]), subject("astralis", grads(0, 0, 0), ["ASTRALIS"])];
  const lowCaps = [
    token("n", "Ni Hao Cat", "NIHAO", 93_000, { source: "theme", groupKey: "ni hao" }),
    token("g", "GTA VI", "GTA6", 41_000, { source: "theme", groupKey: "gta6" }),
  ];

  it("Jensen at $96k is a Meta on its 12 graduations; a launch theme with a bigger crowd but no graduations is nothing", () => {
    const r = run({ subjects: [...others, jensenWave], tokens: [...lowCaps, token("j", "Jensen Huang", "JENSEN", 96_000), token("s", "Stand with Jensen", "STAND", 95_000), token("a", "ASTRALIS", "ASTRALIS", 1_700)] });
    expect(keys(r.metas)).toEqual(["jensen"]);
    expect(r.metas[0]!.leader).toMatchObject({ symbol: "JENSEN", marketCapUsd: 96_000 });
    expect(r.watching).toEqual([]);
  });

  it("the same fixture with the Jensen leader at $2M changes only the leader's figure", () => {
    const r = run({ subjects: [...others, jensenWave], tokens: [...lowCaps, token("j", "Jensen Huang", "JENSEN", 2_000_000), token("s", "Stand with Jensen", "STAND", 95_000)] });
    expect(keys(r.metas)).toEqual(["jensen"]);
    expect(r.metas[0]!.leader).toMatchObject({ symbol: "JENSEN", marketCapUsd: 2_000_000 });
  });
});

describe("currentMetas: matching a leader to the subject that copies it", () => {
  it("a token of any age matches the group that names it: Jensen Huang ($JENSEN) matches the jensen group by its ticker form", () => {
    const r = run({ subjects: [subject("jensen", 14, ["Jensen Huang"]), subject("other", 12, ["Other"])], tokens: [token("j", "Jensen Huang", "JENSEN", 1_500_000)] });
    expect(r.metas.find((m) => m.key === "jensen")!.leader.marketCapUsd).toBe(1_500_000);
    expect(r.metas.find((m) => m.key === "other")!.leader.marketCapUsd).toBe(0);
  });

  it("matches through a whole name of one of the group's tokens, spaces removed", () => {
    const r = run({ subjects: [subject("nihao", 30, ["Mi Hao Cat", "Ni Hao"])], tokens: [token("n", "NiHao", "NH", 1_500_000)] });
    expect(r.metas[0]!.leader.marketCapUsd).toBe(1_500_000);
  });

  it("a generic key and a key under 4 characters never match", () => {
    const r = run({ subjects: [subject("ai", 50, ["AI"]), subject("gpt", 50, ["GPT"]), subject("coin", 50, ["Coin"])], tokens: [token("a", "AI", "AI", 5_000_000), token("g", "GPT", "GPT", 5_000_000), token("c", "Coin", "COIN", 5_000_000)] });
    expect(r.metas.map((m) => m.leader.marketCapUsd)).toEqual([0, 0, 0]); // the subjects qualify on graduations; none of the tokens names one
  });

  it("a token that names two subjects goes to the one with more graduations, then the smaller key", () => {
    const subjects = [subject("moon", 12, ["Moon Cat"]), subject("mooncat", 25, ["Moon Cat"])];
    const led = (rows: CurrentMeta[]) => rows.filter((m) => m.leader.marketCapUsd > 0).map((m) => m.key);
    expect(led(run({ subjects, tokens: [token("m", "Moon Cat", "MCAT", 2_000_000)] }).metas)).toEqual(["mooncat"]);
    const tied = [subject("moon", 12, ["Moon Cat"]), subject("mooncat", 12, ["Moon Cat"])];
    expect(led(run({ subjects: tied, tokens: [token("m", "Moon Cat", "MCAT", 2_000_000)] }).metas)).toEqual(["moon"]);
  });

  it("a token matching only a subject below the graduation rules does not lead it", () => {
    const r = run({ subjects: [subject("jensen", grads(3, 1, 3), ["Jensen"])], tokens: [token("j", "Jensen Huang", "JENSEN", 5_000_000)] });
    expect(r).toEqual({ metas: [], watching: [] });
  });

  it("10,000-character names and RegExp metacharacters run in linear time and match nothing they should not", () => {
    const evil = "(a+)+$[".repeat(1_500);
    const subjects = [subject("jensen", 14, ["Jensen"]), subject("x".repeat(10_000), 14, [evil])];
    const t0 = performance.now();
    const r = run({ subjects, tokens: [token("e", "z".repeat(10_000), "(q+)+$[".repeat(1_500), 3_000_000), token("x", "y".repeat(10_000), ".*".repeat(5_000), 2_000_000), token("j", "Jensen!", "(jensen)+$", 1_200_000)] });
    expect(performance.now() - t0).toBeLessThan(2_000);
    // The hostile tokens name no subject; the metacharacters are plain characters and drop out of the key.
    expect(r.metas.filter((m) => m.leader.marketCapUsd > 0).map((m) => [m.key, m.leader.mint])).toEqual([["jensen", mintOf("j")]]);
  });
});

/**
 * Meta redesign ticket 13: the real run 330 (2026-11-18T01:24Z). The GTA 6 launch cluster held 559 tokens; two spam creates named
 * `dacity coin` with the ticker `fartcoin` had been swept into it, so "fartcoin" became one of its name forms and the real Fartcoin
 * ($90M, trending, which the AI grouping left out of every subject) matched the subject, out-ranked the GTA VI token ($15.5M) and led the Meta.
 */
describe("currentMetas: an off-subject large-cap token cannot lead a Meta (ticket 13)", () => {
  const gtaNames: Array<[string, string, number]> = [["GTA 6", "GTA COIN", 68], ["GTA6", "GTA6", 58], ["GTA VI", "$GTA", 10], ["GTAVI", "GTAVI", 8], ["Official Grand Theft Auto VI", "GTAVI", 7], ["GTA VI", "GTAVI", 6], ["GTA 6", "GTA6", 6], ["Grand Theft Ansem", "GTA", 4]];
  const gtaTokens = gtaNames.flatMap(([name, symbol, n]) => Array.from({ length: n }, () => ({ name, symbol })));
  const filler = Array.from({ length: 559 - gtaTokens.length - 2 }, (_, i) => ({ name: `GTA 6 Rp${i}`, symbol: `GTA6RP${i}` }));
  const spam = [{ name: "dacity coin", symbol: "fartcoin" }, { name: "dacity coin", symbol: "fartcoin" }];
  const gta6: LeaderSubject = { key: "gta6", label: "GTA6", counts: counts(244), topTokens: [], tokens: [...gtaTokens, ...filler, ...spam], grads: grads(40, 6, 30), graduates: [graduate("gradlast", "GTA 6 Latest", "GTA6L", 20)] };
  const gtaVi = token("gtavi", "GTA VI", "GTA VI", 15_550_730, { groupKey: "gta6" });
  const fartcoin = token("fart", "Fartcoin", "Fartcoin", 90_226_224);

  it("two spam creates that copy the ticker inside the 559-token GTA 6 cluster do not make Fartcoin its leader", () => {
    expect(gta6.tokens).toHaveLength(559);
    const r = run({ subjects: [gta6], tokens: [fartcoin, gtaVi] });
    expect(r.metas.map((m) => [m.key, m.leader.mint])).toEqual([["gta6", gtaVi.mint]]);
  });

  it("a Fartcoin that is the only priced token leads nothing: the Meta shows the subject's latest graduate and a dash", () => {
    const r = run({ subjects: [gta6], tokens: [fartcoin] });
    expect(r.metas.map((m) => [m.key, m.leader.mint, m.leader.marketCapUsd])).toEqual([["gta6", mintOf("gradlast"), 0]]);
  });

  it("a Meta that already has Fartcoin as its leader corrects itself on the next AI-grouped run (the live state of run 446)", () => {
    const previous = previousAt(15, [prevRow("gta6", fartcoin, { enteredAt: "2026-11-17T12:47:34.915Z" })]);
    // The AI step was shown Fartcoin and left it out of GTA 6: having led it last run no longer keeps it there. The Meta keeps its entry time.
    const r = run({ subjects: [gta6], tokens: [fartcoin, gtaVi], previous, grouped: new Set([fartcoin.mint]) });
    expect(r.metas.map((m) => [m.key, m.leader.mint, m.enteredAt])).toEqual([["gta6", gtaVi.mint, "2026-11-17T12:47:34.915Z"]]);
  });

  it("a previous leader the AI step did not see (a run with no AI answer) keeps the carry: a Meta is not lost to a failed grouping call", () => {
    const trump = token("trump", "OFFICIAL TRUMP", "TRUMP", 277_000_000);
    const subjects = [subject("trumpedo", 13, ["Trumpedo", "Trumpedo Coin"])];
    const previous = previousAt(15, [prevRow("trumpedo", trump)]);
    expect(run({ subjects, tokens: [trump], previous }).metas[0]!.leader.mint).toBe(trump.mint);
    // The AI step held it as a member of the subject: it leads by membership, as before.
    const held = [{ ...subjects[0]!, memberMints: [trump.mint] }];
    expect(run({ subjects: held, tokens: [trump], previous, grouped: new Set([trump.mint]) }).metas[0]!.leader.mint).toBe(trump.mint);
  });

  it("a token named by a tenth of the subject's tokens still leads it by name, and stays its leader on the next run", () => {
    const named = token("gta", "GTA 6", "GTA COIN", 20_000_000);
    const first = run({ subjects: [gta6], tokens: [named, gtaVi] });
    expect(first.metas[0]!.leader.mint).toBe(named.mint);
    const next = run({ subjects: [gta6], tokens: [named, gtaVi], previous: previousAt(15, first.metas) });
    expect(next.metas[0]!.leader.mint).toBe(named.mint);
  });
});

describe("currentMetas: stale figures and carried state", () => {
  const jensen = subject("jensen", 14, ["Jensen Huang", "Jensen"], { graduates: [graduate("g1", "Jensen Late", "JLATE", 10)] });
  const lead = token("j", "Jensen Huang", "JENSEN", 1_300_000);

  it("a previous Meta whose leader was not looked up this run stays at its last figure, marked stale", () => {
    const r = run({ subjects: [jensen], previous: previousAt(15, [prevRow("jensen", lead)]) });
    expect(r.metas[0]).toMatchObject({ key: "jensen", leader: { mint: lead.mint, marketCapUsd: 1_300_000, stale: true }, holding: false });
  });

  it("a stale figure expires stateMaxMinutes after it was last read, however recent the run that re-saved it: the Meta stays, on the latest graduate and a dash", () => {
    const aged = (minutes: number) => prevRow("jensen", lead, { leader: { ...prevRow("jensen", lead).leader, stale: true, freshAt: new Date(NOW.getTime() - minutes * 60_000).toISOString() } });
    // the previous run was 15 minutes ago (it carried the row again), the figure is older
    const edge = run({ subjects: [jensen], previous: previousAt(15, [aged(config.stateMaxMinutes)]) });
    expect(edge.metas[0]).toMatchObject({ key: "jensen", leader: { mint: lead.mint, marketCapUsd: 1_300_000, stale: true, freshAt: new Date(NOW.getTime() - config.stateMaxMinutes * 60_000).toISOString() } });
    const past = run({ subjects: [jensen], previous: previousAt(15, [aged(config.stateMaxMinutes + 1)]) });
    expect(past.metas[0]).toMatchObject({ key: "jensen", enteredAt: "2026-11-15T09:00:00.000Z", leader: { mint: mintOf("g1"), marketCapUsd: 0, stale: false } });
    // a fresh reading is not a carry
    const again = run({ subjects: [jensen], tokens: [{ ...lead, marketCapUsd: 1_100_000 }], previous: previousAt(15, [aged(config.stateMaxMinutes + 1)]) });
    expect(again.metas[0]).toMatchObject({ key: "jensen", leader: { marketCapUsd: 1_100_000, stale: false, freshAt: NOW.toISOString() } });
  });

  it("carriedState keeps a run within stateMaxMinutes whole, whatever its leaders' figures, and drops an older or unreadable one", () => {
    const old = previousAt(config.stateMaxMinutes + 1, [prevRow("jensen", lead)]);
    expect(carriedState(old, NOW, config.stateMaxMinutes)).toBeUndefined();
    const edge = previousAt(config.stateMaxMinutes, [prevRow("jensen", lead)], [prevRow("jensen", lead)]);
    expect(carriedState(edge, NOW, config.stateMaxMinutes)).toBe(edge);
    expect(carriedState({ ...old, computedAt: "nonsense" }, NOW, 120)).toBeUndefined();
    expect(carriedState(undefined, NOW, 120)).toBeUndefined();
  });

  it("a Meta needs no figure: a stale Watching leader never creates a Meta, and a subject with graduations and no price is a Meta with a dash", () => {
    const watchingRow = prevRow("jensen", token("j", "Jensen Huang", "JENSEN", 1_200_000));
    const r = run({ subjects: [subject("jensen", grads(7, 1, 7), ["Jensen"], { graduates: [graduate("g1", "Jensen Late", "JLATE", 10)] })], previous: previousAt(15, [], [watchingRow]) });
    expect(r.metas).toEqual([]);
    expect(r.watching[0]).toMatchObject({ key: "jensen", leader: { mint: lead.mint, stale: true, marketCapUsd: 1_200_000 } });
    const plain = run({ subjects: [jensen] });
    expect(plain.metas[0]!.leader).toMatchObject({ mint: mintOf("g1"), marketCapUsd: 0 });
  });

  it("a fresh figure replaces the stale one, and a fresh lower token never drops a stale Meta below its last cap", () => {
    const lower = token("k", "Jensen", "JENSEN2", 600_000);
    const r = run({ subjects: [jensen], tokens: [lower], previous: previousAt(15, [prevRow("jensen", lead)]) });
    expect(r.metas[0]!.leader).toMatchObject({ mint: lead.mint, stale: true, marketCapUsd: 1_300_000 });
    const fresh = run({ subjects: [jensen], tokens: [{ ...lead, marketCapUsd: 520_000 }], previous: previousAt(15, [prevRow("jensen", lead)]) });
    expect(fresh.metas[0]).toMatchObject({ leader: { marketCapUsd: 520_000, stale: false } });
  });

  it("state older than stateMaxMinutes (a pause) is not carried: the Meta at 7 graduations is plain Watching again", () => {
    const old = previousAt(config.stateMaxMinutes + 1, [prevRow("jensen", lead)]);
    const r = run({ subjects: [subject("jensen", grads(7, 1, 7), ["Jensen"])], tokens: [token("j", "Jensen Huang", "JENSEN", 800_000)], previous: old });
    expect(r.metas).toEqual([]);
    expect(keys(r.watching)).toEqual(["jensen"]);
    const gone = run({ subjects: [jensen], previous: old });
    expect(gone.metas[0]!.enteredAt).toBe(NOW.toISOString());
  });

  it("a Meta whose subject no longer exists (no graduations left to count) ends, and a Meta whose group key changed is continued by its leader's name", () => {
    const row = prevRow("jensen", lead, { label: "Jensen Huang", topTokens: [{ mint: lead.mint, name: "Jensen Huang", symbol: "JENSEN" }] });
    expect(run({ subjects: [], tokens: [{ ...lead, marketCapUsd: 900_000 }], previous: previousAt(15, [row]) })).toEqual({ metas: [], watching: [] });
    const r = run({ subjects: [subject("jensen huang", grads(7, 1, 7), ["Jensen Huang"])], tokens: [{ ...lead, marketCapUsd: 700_000 }], previous: previousAt(15, [prevRow("jensen", lead)]) });
    expect(r.metas[0]).toMatchObject({ key: "jensen huang", holding: true, enteredAt: "2026-11-15T09:00:00.000Z" });
  });

  it("a Watching subject keeps its entry time while it stays Watching", () => {
    const w = prevRow("jensen", token("j", "Jensen Huang", "JENSEN", 90_000), { enteredAt: "2026-11-15T12:00:00.000Z" });
    const r = run({ subjects: [subject("jensen", grads(6, 1, 6), ["Jensen Huang"])], tokens: [token("j", "Jensen Huang", "JENSEN", 96_000)], previous: previousAt(15, [], [w]) });
    expect(r.watching[0]!.enteredAt).toBe("2026-11-15T12:00:00.000Z");
  });
});
