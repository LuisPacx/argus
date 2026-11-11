import { describe, expect, it } from "vitest";
import type { MetaCounts, MetaRow, MetaRun } from "../meta/store.ts";
import { ROOM_LEFT_RULE, rankRoomLeft } from "./room-left.ts";

const NOW = "2026-11-11T20:00:00.000Z";
const minutesBefore = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

interface Shape {
  label: string;
  /** 24 h counts. */
  tokens: number;
  migrations: number;
  /** Of the migrations, those more than 60 s after the create (default: all). */
  after60?: number;
  creators: number;
  /** 6 h tokens (default: half of the 24 h count). */
  tokens6h?: number;
  leadCap?: number;
  firstSeenMinAgo?: number;
}

const counts = (tokens: number, creators: number, migrations: number, after60: number): MetaCounts => ({ tokens, creators, migrations, migrationsAfter60s: after60 });

function row(s: Shape, rank: number): MetaRow {
  const after60 = s.after60 ?? s.migrations;
  const t6 = s.tokens6h ?? Math.round(s.tokens / 2);
  return {
    rank,
    window: "24h",
    key: s.label.toLowerCase().replace(/\W+/g, ""),
    label: s.label,
    firstSeenAt: minutesBefore(s.firstSeenMinAgo ?? 20 * 60),
    counts: {
      "24h": counts(s.tokens, s.creators, s.migrations, after60),
      "6h": counts(t6, Math.max(1, Math.round(s.creators / 2)), Math.round(s.migrations / 2), Math.round(after60 / 2)),
    },
    topTokens: [{ mint: `${s.label}-mint`, name: s.label, symbol: s.label.slice(0, 4).toUpperCase(), ...(s.leadCap !== undefined ? { marketCapUsd: s.leadCap } : {}) }],
    ...(s.leadCap !== undefined ? { topMarketCapUsd: s.leadCap, marketCapUsd: s.leadCap } : {}),
    migrationRate: s.tokens > 0 ? s.migrations / s.tokens : 0,
    createsPerMigration: s.migrations > 0 ? s.tokens / s.migrations : null,
  };
}

/** The base rate of the 2026-11-09..11 data: about 2.8% of creates migrate. */
function run(shapes: Shape[], base = { tokens: 10_000, migrations: 280 }): MetaRun {
  return {
    id: 1,
    computedAt: NOW,
    window: "24h",
    note: "",
    dexCalls: 0,
    dexFailures: 0,
    windowTokens: base.tokens,
    windowMigrations: base.migrations,
    baseMigrationRate: base.tokens > 0 ? base.migrations / base.tokens : null,
    rows: shapes.map((s, i) => row(s, i + 1)),
  };
}

// The 2026-11-11 probe shapes (24 h to 20:00 UTC, migrations unfiltered).
const GTA: Shape = { label: "GTA VI", tokens: 153, migrations: 31, after60: 20, creators: 60, leadCap: 3_000_000 };
const NIHAO: Shape = { label: "ni hao", tokens: 310, migrations: 15, after60: 12, creators: 80, leadCap: 2_000_000 };
const DEEPSEEK: Shape = { label: "DeepSeek", tokens: 11, migrations: 10, after60: 8, creators: 7, tokens6h: 8, leadCap: 1_500_000 };
const DACITY: Shape = { label: "Dacity", tokens: 228, migrations: 1, after60: 1, creators: 12, leadCap: 4_000_000 };
const SMALL_LEAD: Shape = { label: "Small lead", tokens: 60, migrations: 12, creators: 20, leadCap: 50_000 };
const TOO_NEW: Shape = { label: "Too new", tokens: 40, migrations: 8, creators: 15, leadCap: 2_000_000, firstSeenMinAgo: 10 };
const FADING: Shape = { label: "Fading", tokens: 100, migrations: 20, creators: 30, tokens6h: 10, leadCap: 2_000_000 };

describe("rankRoomLeft (slice 1): the 2026-11-11 shapes", () => {
  const ranking = () => rankRoomLeft(run([NIHAO, DACITY, GTA, DEEPSEEK, SMALL_LEAD, TOO_NEW, FADING]));

  it("offers DeepSeek and GTA VI, then ni hao, and removes the rest with the gate that did it", () => {
    const r = ranking();
    expect(r.candidates.map((c) => c.row.label)).toEqual(["DeepSeek", "GTA VI", "ni hao"]);
    const why = Object.fromEntries(r.rejected.map((x) => [x.row.label, x]));
    expect(why["Dacity"]).toMatchObject({ gate: "saturated" });
    expect(why["Dacity"]?.reason).toContain("228");
    expect(why["Small lead"]).toMatchObject({ gate: "lead" });
    expect(why["Too new"]).toMatchObject({ gate: "young" });
    expect(why["Fading"]).toMatchObject({ gate: "fading" });
  });

  it("a larger Meta does not outrank a smaller one with more room left (size order is not room-left order)", () => {
    const bySize = [NIHAO, DACITY, GTA, DEEPSEEK].sort((a, b) => b.tokens - a.tokens).map((s) => s.label);
    expect(bySize).toEqual(["ni hao", "Dacity", "GTA VI", "DeepSeek"]);
    const roomLeft = rankRoomLeft(run([NIHAO, DACITY, GTA, DEEPSEEK])).candidates.map((c) => c.row.label);
    expect(roomLeft).toEqual(["DeepSeek", "GTA VI", "ni hao"]);
  });

  it("gives the same output for the same input, and for the input in another order", () => {
    const a = ranking();
    expect(ranking()).toEqual(a);
    const shuffled = rankRoomLeft(run([FADING, TOO_NEW, DEEPSEEK, SMALL_LEAD, GTA, DACITY, NIHAO]));
    expect(shuffled.candidates.map((c) => c.row.label)).toEqual(a.candidates.map((c) => c.row.label));
    expect(shuffled.rejected.map((c) => c.row.label).sort()).toEqual(a.rejected.map((c) => c.row.label).sort());
  });

  it("every candidate says why in its reasons: the lift, the momentum and the lead", () => {
    const [first] = ranking().candidates;
    expect(first?.reasons.join(" | ")).toMatch(/lift 32\.5x base/);
    expect(first?.reasons.join(" | ")).toContain("momentum");
    expect(first?.reasons.join(" | ")).toContain("$1.5M");
  });

  it("measures lift on migrations after 60 s when most of a group's migrations were bundled with the create, and says so", () => {
    const bundled: Shape = { label: "Bundled", tokens: 100, migrations: 20, after60: 4, creators: 30, leadCap: 2_000_000 };
    const plain: Shape = { label: "Plain", tokens: 100, migrations: 10, after60: 9, creators: 30, leadCap: 2_000_000 };
    const r = rankRoomLeft(run([bundled, plain]));
    const [first, second] = r.candidates;
    // Unfiltered, Bundled would lead (20% vs 10%); on after-60-s it is 4% against 9%.
    expect(first?.row.label).toBe("Plain");
    expect(first).toMatchObject({ liftBasis: "unfiltered" });
    expect(second).toMatchObject({ row: { label: "Bundled" }, liftBasis: "after-60s" });
    expect(second?.reasons[0]).toContain("after-60s");
    expect(second?.lift).toBeCloseTo(0.04 / 0.028, 5);
  });

  it("breaks lift ties by momentum, then lead market cap, then creators, then the key", () => {
    const base: Shape = { label: "b", tokens: 100, migrations: 10, creators: 10, tokens6h: 50, leadCap: 2_000_000 };
    const r = rankRoomLeft(run([
      { ...base, label: "d-key" },
      { ...base, label: "a-key" },
      { ...base, label: "creators", creators: 11 },
      { ...base, label: "cap", leadCap: 3_000_000 },
      { ...base, label: "momentum", tokens6h: 60 },
    ]));
    expect(r.candidates.map((c) => c.row.label)).toEqual(["momentum", "cap", "creators", "a-key", "d-key"]);
  });

  it("a Meta with no market cap fails the lead gate; with the gate switched off (the backtest) it passes", () => {
    const noCap: Shape = { label: "No cap", tokens: 100, migrations: 10, creators: 10 };
    expect(rankRoomLeft(run([noCap])).rejected[0]).toMatchObject({ gate: "lead" });
    const off = rankRoomLeft(run([noCap]), { ...ROOM_LEFT_RULE, minLeadMarketCapUsd: null });
    expect(off.candidates.map((c) => c.row.label)).toEqual(["No cap"]);
  });

  it("rejects a Meta with fewer than 5 distinct creators as thin evidence", () => {
    const thin: Shape = { label: "Thin", tokens: 40, migrations: 10, creators: 4, leadCap: 2_000_000 };
    expect(rankRoomLeft(run([thin])).rejected[0]).toMatchObject({ gate: "evidence", reason: "4 distinct creators in 24 h, under 5" });
  });

  it("can require a minimum number of migrations as evidence, off by default: one migration out of six is a lift of 6x and means nothing", () => {
    const tiny: Shape = { label: "Tiny", tokens: 6, migrations: 1, creators: 6, leadCap: 2_000_000 };
    expect(ROOM_LEFT_RULE.minMigrations).toBe(0);
    expect(rankRoomLeft(run([tiny])).candidates.map((c) => c.row.label)).toEqual(["Tiny"]);
    const strict = rankRoomLeft(run([tiny, GTA]), { ...ROOM_LEFT_RULE, minMigrations: 3 });
    expect(strict.candidates.map((c) => c.row.label)).toEqual(["GTA VI"]);
    expect(strict.rejected[0]).toMatchObject({ gate: "evidence", reason: "migrations in 24 h: 1, under 3" });
  });

  it("counts those migrations on the same basis as the lift: after 60 s when most were bundled", () => {
    const bundled: Shape = { label: "Bundled", tokens: 100, migrations: 6, after60: 1, creators: 30, leadCap: 2_000_000 };
    const strict = rankRoomLeft(run([bundled]), { ...ROOM_LEFT_RULE, minMigrations: 3 });
    expect(strict.rejected[0]).toMatchObject({ gate: "evidence", reason: "migrations after 60 s in 24 h: 1, under 3" });
  });

  it("rejects a Meta none of whose creates migrated as saturated, without dividing by zero", () => {
    const dead: Shape = { label: "Dead", tokens: 40, migrations: 0, creators: 20, leadCap: 2_000_000 };
    expect(rankRoomLeft(run([dead])).rejected[0]).toMatchObject({ gate: "saturated" });
  });

  it("offers nothing when the run has no base rate, and says why on every row", () => {
    const empty = run([GTA], { tokens: 0, migrations: 0 });
    const r = rankRoomLeft(empty);
    expect(r.candidates).toEqual([]);
    expect(r.rejected).toMatchObject([{ gate: "no-base-rate" }]);
    expect(r.baseMigrationRate).toBeNull();
  });

  it("refuses the 6 h run: its base rate is not the 24 h one", () => {
    expect(() => rankRoomLeft({ ...run([GTA]), window: "6h" })).toThrow(RangeError);
  });

  it("has the rule's gates as stated: $1M lead, 5 creators, 3x the base creates per migration, a quarter at 6 h, 30 minutes", () => {
    expect(ROOM_LEFT_RULE).toMatchObject({ minLeadMarketCapUsd: 1_000_000, minCreators: 5, saturationFactor: 3, minRecentShare: 0.25, minAgeMinutes: 30 });
  });
});
