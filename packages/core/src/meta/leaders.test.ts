import { describe, expect, it } from "vitest";
import { META_RULE } from "./config.ts";
import { carriedState, currentMetas, type LeaderSubject, type LeaderToken, type PreviousMetas } from "./leaders.ts";
import type { CurrentMeta, MetaCounts } from "./store.ts";

const NOW = new Date("2026-11-15T15:35:00.000Z");
const config = META_RULE;

const counts = (creators: number): Record<"6h" | "24h", MetaCounts> => ({
  "6h": { tokens: creators, creators: Math.ceil(creators / 2), migrations: 0, migrationsAfter60s: 0 },
  "24h": { tokens: creators * 2, creators, migrations: 1, migrationsAfter60s: 1 },
});

/** A launch-theme subject: `key` is the group key, `names` are the names of its tokens. */
const subject = (key: string, creators: number, names: string[] = [key], label = key): LeaderSubject => ({
  key,
  label,
  counts: counts(creators),
  topTokens: [],
  tokens: names.map((name) => ({ name, symbol: name.toUpperCase().slice(0, 8) })),
});

const mintOf = (n: string) => `${n}`.padEnd(40, "x") + "pump";
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

const run = (over: { subjects: LeaderSubject[]; tokens: LeaderToken[]; previous?: PreviousMetas; now?: Date }) => currentMetas({ now: NOW, config, ...over });
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

describe("currentMetas: who is a Meta and who is Watching", () => {
  const jensen = subject("jensen", 14, ["Jensen Huang", "Jensen", "Stand with Jensen"]);

  it("a leader at $2.1M with 14 creators becomes a Meta; the same at $96k is Watching; at $2.1M with 9 creators it is neither", () => {
    const big = run({ subjects: [jensen], tokens: [token("j", "Jensen Huang", "JENSEN", 2_100_000)] });
    expect(keys(big.metas)).toEqual(["jensen"]);
    expect(big.metas[0]).toMatchObject({ holding: false, enteredAt: NOW.toISOString(), leader: { symbol: "JENSEN", marketCapUsd: 2_100_000, stale: false }, counts: counts(14) });
    expect(big.watching).toEqual([]);

    const small = run({ subjects: [jensen], tokens: [token("j", "Jensen Huang", "JENSEN", 96_000)] });
    expect(small.metas).toEqual([]);
    expect(keys(small.watching)).toEqual(["jensen"]);

    const few = run({ subjects: [subject("jensen", 9, ["Jensen"])], tokens: [token("j", "Jensen Huang", "JENSEN", 2_100_000)] });
    expect(few).toEqual({ metas: [], watching: [] });
  });

  it("a Meta stays while its leader holds $500k (holding between the two caps), keeps its entry time, and a copy count below 10 does not end it", () => {
    const lead = token("j", "Jensen Huang", "JENSEN", 800_000);
    const before = prevRow("jensen", token("j", "Jensen Huang", "JENSEN", 1_300_000));
    const stays = run({ subjects: [jensen], tokens: [lead], previous: previousAt(15, [before]) });
    expect(stays.metas[0]).toMatchObject({ key: "jensen", holding: true, enteredAt: "2026-11-15T09:00:00.000Z" });
    expect(stays.watching).toEqual([]);

    const fewCopies = run({ subjects: [subject("jensen", 3, ["Jensen"])], tokens: [lead], previous: previousAt(15, [before]) });
    expect(keys(fewCopies.metas)).toEqual(["jensen"]);
    expect(fewCopies.metas[0]!.counts["24h"].creators).toBe(3);
  });

  it("the same $800k leader that was not a Meta last run is Watching, and a Meta at $400k drops and competes for Watching", () => {
    const lead = token("j", "Jensen Huang", "JENSEN", 800_000);
    const never = run({ subjects: [jensen], tokens: [lead], previous: previousAt(15, []) });
    expect(never.metas).toEqual([]);
    expect(keys(never.watching)).toEqual(["jensen"]);

    const dropped = run({ subjects: [jensen], tokens: [token("j", "Jensen Huang", "JENSEN", 400_000)], previous: previousAt(15, [prevRow("jensen", lead)]) });
    expect(dropped.metas).toEqual([]);
    expect(keys(dropped.watching)).toEqual(["jensen"]);
    expect(dropped.watching[0]).toMatchObject({ holding: false, enteredAt: NOW.toISOString() });

    const droppedNoCopies = run({ subjects: [subject("jensen", 4, ["Jensen"])], tokens: [token("j", "Jensen Huang", "JENSEN", 400_000)], previous: previousAt(15, [prevRow("jensen", lead)]) });
    expect(droppedNoCopies).toEqual({ metas: [], watching: [] });
  });

  it("at most 3 Metas, highest cap first, ties by key; a fourth over $1M is not a Meta and not Watching", () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo"];
    const subjects = names.map((n) => subject(n, 12, [n]));
    const tokens = [
      token("1", "alpha", "ALPHA", 3_000_000),
      token("2", "bravo", "BRAVO", 2_000_000),
      token("3", "charlie", "CHARLIE", 2_000_000),
      token("4", "delta", "DELTA", 1_500_000),
      token("5", "echo", "ECHO", 700_000),
    ];
    const r = run({ subjects, tokens });
    expect(keys(r.metas)).toEqual(["alpha", "bravo", "charlie"]);
    expect(keys(r.watching)).toEqual(["echo"]);
  });

  it("Watching holds the top 3 below $1M, by cap, and never a Meta", () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo"];
    const subjects = names.map((n) => subject(n, 12, [n]));
    const tokens = [
      token("1", "alpha", "ALPHA", 1_200_000),
      token("2", "bravo", "BRAVO", 900_000),
      token("3", "charlie", "CHARLIE", 300_000),
      token("4", "delta", "DELTA", 200_000),
      token("5", "echo", "ECHO", 100_000),
    ];
    const r = run({ subjects, tokens });
    expect(keys(r.metas)).toEqual(["alpha"]);
    expect(keys(r.watching)).toEqual(["bravo", "charlie", "delta"]);
  });

  it("the knobs move the rule: a $2M enter cap, 12 copies, one Meta, no Watching", () => {
    const subjects = [subject("alpha", 11, ["alpha"]), subject("bravo", 13, ["bravo"]), subject("charlie", 13, ["charlie"])];
    const tokens = [token("1", "alpha", "ALPHA", 5_000_000), token("2", "bravo", "BRAVO", 2_500_000), token("3", "charlie", "CHARLIE", 1_500_000)];
    const r = currentMetas({ subjects, tokens, now: NOW, config: { ...config, enterMcapUsd: 2_000_000, minCopies: 12, maxMetas: 1, watching: 0 } });
    expect(keys(r.metas)).toEqual(["bravo"]);
    expect(r.watching).toEqual([]);
  });

  it("a theme's own token needs no name match (groupKey), and the biggest token leads", () => {
    const s = subject("gta6", 40, ["GTA 6 Cat", "GTA VI"]);
    const r = run({ subjects: [s], tokens: [token("a", "Mi", "M", 1_100_000, { source: "theme", groupKey: "gta6" }), token("b", "Whatever", "W", 400_000, { source: "theme", groupKey: "gta6" })] });
    expect(r.metas[0]).toMatchObject({ key: "gta6", leader: { symbol: "M", source: "theme" } });
  });
});

describe("currentMetas: replay of run 143", () => {
  // Run 143: the 24 h window held 50 rows, none at or above $250k; the live leader was the Jensen token at $96k (11-14), another Jensen token at $95k, a $1.7k one.
  const jensen = subject("jensen", 12, ["Jensen Huang", "Jensen", "Stand with Jensen", "Jensen Coin"]);
  const others = [subject("ni hao", 156, ["Ni Hao Cat", "Mi Hao"]), subject("gta6", 65, ["GTA 6 Cat", "GTA VI"]), subject("astralis", 4, ["ASTRALIS"])];
  const lowCaps = [
    token("n", "Ni Hao Cat", "NIHAO", 93_000, { source: "theme", groupKey: "ni hao" }),
    token("g", "GTA VI", "GTA6", 41_000, { source: "theme", groupKey: "gta6" }),
  ];

  it("no leader at or above $250k and Jensen at $96k: no Meta, and Jensen is Watching with its copies", () => {
    const r = run({
      subjects: [...others, jensen],
      tokens: [...lowCaps, token("j", "Jensen Huang", "JENSEN", 96_000), token("s", "Stand with Jensen", "STAND", 95_000), token("a", "ASTRALIS", "ASTRALIS", 1_700)],
    });
    expect(r.metas).toEqual([]);
    expect(keys(r.watching)).toEqual(["jensen", "ni hao", "gta6"]);
    expect(r.watching[0]!.leader).toMatchObject({ symbol: "JENSEN", marketCapUsd: 96_000 });
  });

  it("the same fixture with the Jensen leader at $2M gives one Meta", () => {
    const r = run({ subjects: [...others, jensen], tokens: [...lowCaps, token("j", "Jensen Huang", "JENSEN", 2_000_000), token("s", "Stand with Jensen", "STAND", 95_000)] });
    expect(keys(r.metas)).toEqual(["jensen"]);
    expect(r.metas[0]!.leader.symbol).toBe("JENSEN");
    expect(keys(r.watching)).toEqual(["ni hao", "gta6"]);
  });
});

describe("currentMetas: matching a leader to the subject that copies it", () => {
  it("a token of any age matches the group that names it: Jensen Huang ($JENSEN) matches the jensen group by its ticker form", () => {
    const r = run({ subjects: [subject("jensen", 14, ["Jensen Huang"]), subject("other", 20, ["Other"])], tokens: [token("j", "Jensen Huang", "JENSEN", 1_500_000)] });
    expect(keys(r.metas)).toEqual(["jensen"]);
  });

  it("matches through a whole name of one of the group's tokens, spaces removed", () => {
    const r = run({ subjects: [subject("nihao", 30, ["Mi Hao Cat", "Ni Hao"])], tokens: [token("n", "NiHao", "NH", 1_500_000)] });
    expect(keys(r.metas)).toEqual(["nihao"]);
  });

  it("a generic key and a key under 4 characters never match", () => {
    const r = run({ subjects: [subject("ai", 50, ["AI"]), subject("gpt", 50, ["GPT"]), subject("coin", 50, ["Coin"])], tokens: [token("a", "AI", "AI", 5_000_000), token("g", "GPT", "GPT", 5_000_000), token("c", "Coin", "COIN", 5_000_000)] });
    expect(r).toEqual({ metas: [], watching: [] });
  });

  it("a token that names two eligible subjects goes to the one with more creators, then the smaller key", () => {
    const subjects = [subject("moon", 12, ["Moon Cat"]), subject("mooncat", 25, ["Moon Cat"])];
    expect(keys(run({ subjects, tokens: [token("m", "Moon Cat", "MCAT", 2_000_000)] }).metas)).toEqual(["mooncat"]);
    const tied = [subject("moon", 12, ["Moon Cat"]), subject("mooncat", 12, ["Moon Cat"])];
    expect(keys(run({ subjects: tied, tokens: [token("m", "Moon Cat", "MCAT", 2_000_000)] }).metas)).toEqual(["moon"]);
  });

  it("a token matching only a group below the copies rule is not led by it", () => {
    const r = run({ subjects: [subject("jensen", 3, ["Jensen"])], tokens: [token("j", "Jensen Huang", "JENSEN", 5_000_000)] });
    expect(r).toEqual({ metas: [], watching: [] });
  });

  it("10,000-character names and RegExp metacharacters run in linear time and match nothing they should not", () => {
    const evil = "(a+)+$[".repeat(1_500);
    const subjects = [subject("jensen", 14, ["Jensen"]), subject("x".repeat(10_000), 14, [evil])];
    const t0 = performance.now();
    const r = run({ subjects, tokens: [token("e", "z".repeat(10_000), "(q+)+$[".repeat(1_500), 3_000_000), token("x", "y".repeat(10_000), ".*".repeat(5_000), 2_000_000), token("j", "Jensen!", "(jensen)+$", 1_200_000)] });
    expect(performance.now() - t0).toBeLessThan(2_000);
    // The hostile tokens name no subject; the metacharacters are plain characters and drop out of the key.
    expect(r.metas.map((m) => [m.key, m.leader.mint])).toEqual([["jensen", mintOf("j")]]);
  });
});

describe("currentMetas: stale figures and carried state", () => {
  const jensen = subject("jensen", 14, ["Jensen Huang", "Jensen"]);
  const lead = token("j", "Jensen Huang", "JENSEN", 1_300_000);

  it("a previous Meta whose leader was not looked up this run stays at its last figure, marked stale", () => {
    const r = run({ subjects: [jensen], tokens: [], previous: previousAt(15, [prevRow("jensen", lead)]) });
    expect(r.metas[0]).toMatchObject({ key: "jensen", leader: { mint: lead.mint, marketCapUsd: 1_300_000, stale: true }, holding: false });
  });

  it("a stale carry ends stateMaxMinutes after the figure was last read, however recent the run that re-saved it", () => {
    const aged = (minutes: number) => prevRow("jensen", lead, { leader: { ...prevRow("jensen", lead).leader, stale: true, freshAt: new Date(NOW.getTime() - minutes * 60_000).toISOString() } });
    // the previous run was 15 minutes ago (it carried the row again), the figure is older
    const edge = run({ subjects: [jensen], tokens: [], previous: previousAt(15, [aged(config.stateMaxMinutes)]) });
    expect(edge.metas[0]).toMatchObject({ key: "jensen", leader: { stale: true, freshAt: new Date(NOW.getTime() - config.stateMaxMinutes * 60_000).toISOString() } });
    const past = run({ subjects: [jensen], tokens: [], previous: previousAt(15, [aged(config.stateMaxMinutes + 1)]) });
    expect(past).toEqual({ metas: [], watching: [] });
    // a Watching row expires the same way, and carriedState says which rows survive
    const kept = carriedState(previousAt(15, [aged(config.stateMaxMinutes + 1)], [aged(5)]), NOW, config.stateMaxMinutes)!;
    expect([kept.metas.length, kept.watching.length]).toEqual([0, 1]);
    // a fresh reading is not a carry: the expired row is gone (new entry time), and the enter rule alone decides
    const again = run({ subjects: [jensen], tokens: [{ ...lead, marketCapUsd: 1_100_000 }], previous: previousAt(15, [aged(config.stateMaxMinutes + 1)]) });
    expect(again.metas[0]).toMatchObject({ key: "jensen", enteredAt: NOW.toISOString(), leader: { stale: false, freshAt: NOW.toISOString() } });
    const below = run({ subjects: [jensen], tokens: [{ ...lead, marketCapUsd: 700_000 }], previous: previousAt(15, [aged(config.stateMaxMinutes + 1)]) });
    expect(below.metas).toEqual([]); // holding needs a live previous row
  });

  it("a stale figure never creates a Meta: a previous Watching leader carried at $1.2M stays out", () => {
    const watchingRow = prevRow("jensen", token("j", "Jensen Huang", "JENSEN", 1_200_000));
    const r = run({ subjects: [jensen], tokens: [], previous: previousAt(15, [], [watchingRow]) });
    expect(r.metas).toEqual([]);
    expect(r.watching).toEqual([]); // not below $1M either: a $1.2M figure is not Watching
    const below = run({ subjects: [jensen], tokens: [], previous: previousAt(15, [], [prevRow("jensen", token("j", "Jensen Huang", "JENSEN", 90_000))]) });
    expect(below.watching[0]).toMatchObject({ key: "jensen", leader: { stale: true, marketCapUsd: 90_000 } });
  });

  it("a fresh figure replaces the stale one, and a fresh lower token never drops a stale Meta below its last cap", () => {
    const lower = token("k", "Jensen", "JENSEN2", 600_000);
    const r = run({ subjects: [jensen], tokens: [lower], previous: previousAt(15, [prevRow("jensen", lead)]) });
    expect(r.metas[0]!.leader).toMatchObject({ mint: lead.mint, stale: true, marketCapUsd: 1_300_000 });
    const fresh = run({ subjects: [jensen], tokens: [{ ...lead, marketCapUsd: 520_000 }], previous: previousAt(15, [prevRow("jensen", lead)]) });
    expect(fresh.metas[0]).toMatchObject({ holding: true, leader: { marketCapUsd: 520_000, stale: false } });
  });

  it("state older than stateMaxMinutes (a pause) is not carried: the $800k Meta is plain Watching again", () => {
    const old = previousAt(config.stateMaxMinutes + 1, [prevRow("jensen", lead)]);
    expect(carriedState(old, NOW, config.stateMaxMinutes)).toBeUndefined();
    expect(carriedState(previousAt(config.stateMaxMinutes, []), NOW, config.stateMaxMinutes)).toBeDefined();
    expect(carriedState({ ...old, computedAt: "nonsense" }, NOW, 120)).toBeUndefined();
    const r = run({ subjects: [jensen], tokens: [token("j", "Jensen Huang", "JENSEN", 800_000)], previous: old });
    expect(r.metas).toEqual([]);
    expect(keys(r.watching)).toEqual(["jensen"]);
    const gone = run({ subjects: [jensen], tokens: [], previous: old });
    expect(gone).toEqual({ metas: [], watching: [] });
  });

  it("a Meta whose launch wave is over (no group left) stays on its leader's cap with zero counts", () => {
    const row = prevRow("jensen", lead, { label: "Jensen Huang", topTokens: [{ mint: lead.mint, name: "Jensen Huang", symbol: "JENSEN" }] });
    const r = run({ subjects: [], tokens: [{ ...lead, marketCapUsd: 900_000 }], previous: previousAt(15, [row]) });
    expect(r.metas[0]).toMatchObject({ key: "jensen", label: "Jensen Huang", holding: true, counts: { "24h": { tokens: 0, creators: 0 } }, enteredAt: row.enteredAt });
    expect(r.metas[0]!.topTokens).toHaveLength(1);
  });

  it("a Meta whose group key changed is continued by its leader's name", () => {
    const r = run({ subjects: [subject("jensen huang", 14, ["Jensen Huang"])], tokens: [{ ...lead, marketCapUsd: 700_000 }], previous: previousAt(15, [prevRow("jensen", lead)]) });
    expect(r.metas[0]).toMatchObject({ key: "jensen huang", holding: true, enteredAt: "2026-11-15T09:00:00.000Z" });
  });

  it("a Watching subject keeps its entry time while it stays Watching", () => {
    const w = prevRow("jensen", token("j", "Jensen Huang", "JENSEN", 90_000), { enteredAt: "2026-11-15T12:00:00.000Z" });
    const r = run({ subjects: [jensen], tokens: [token("j", "Jensen Huang", "JENSEN", 96_000)], previous: previousAt(15, [], [w]) });
    expect(r.watching[0]!.enteredAt).toBe("2026-11-15T12:00:00.000Z");
  });
});
