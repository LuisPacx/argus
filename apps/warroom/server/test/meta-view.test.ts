import { expect, it } from "vitest";
import { ageText, clampText, fmtUsd, META_POLL_MS, META_STALE_MS, META_TREND, metaAnchor, metaView, trendWord } from "../../app/utils/meta.ts";

const NOW = Date.parse("2026-11-11T20:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

it("trendWord: accelerating at or above 40% of the day's launches in the last 6 h, fading at or below 15%, else steady", () => {
  expect(META_TREND).toEqual({ accelerating: 0.4, fading: 0.15 });
  expect(trendWord(40, 100)).toBe("accelerating");
  expect(trendWord(100, 100)).toBe("accelerating");
  expect(trendWord(39, 100)).toBe("steady");
  expect(trendWord(25, 100)).toBe("steady");
  expect(trendWord(16, 100)).toBe("steady");
  expect(trendWord(15, 100)).toBe("fading");
  expect(trendWord(0, 100)).toBe("fading");
});

it("trendWord: nothing launched in 24 h (or a bad number) has no word", () => {
  expect(trendWord(0, 0)).toBeNull();
  expect(trendWord(5, 0)).toBeNull();
  expect(trendWord(Number.NaN, 10)).toBeNull();
  expect(trendWord(1, Number.POSITIVE_INFINITY)).toBeNull();
  expect(trendWord(-3, 10)).toBe("fading");
});

it("ageText: minutes, hours and days, 'just now' under a minute, and a time in the future clamps to 'just now'", () => {
  expect(ageText(ago(0), NOW)).toBe("just now");
  expect(ageText(new Date(NOW - 59_000).toISOString(), NOW)).toBe("just now");
  expect(ageText(ago(-90), NOW)).toBe("just now"); // 90 minutes in the future
  expect(ageText(ago(1), NOW)).toBe("1 minute ago");
  expect(ageText(ago(12), NOW)).toBe("12 minutes ago");
  expect(ageText(ago(59), NOW)).toBe("59 minutes ago");
  expect(ageText(ago(60), NOW)).toBe("1 hour ago");
  expect(ageText(ago(14 * 60 + 20), NOW)).toBe("14 hours ago");
  expect(ageText(ago(47 * 60 + 59), NOW)).toBe("47 hours ago");
  expect(ageText(ago(48 * 60), NOW)).toBe("2 days ago");
  expect(ageText("not a date", NOW)).toBeNull();
  expect(ageText(ago(5), Number.NaN)).toBeNull();
});

it("fmtUsd and clampText", () => {
  expect([fmtUsd(13_000_000), fmtUsd(2_100_000), fmtUsd(850_000), fmtUsd(1_234), fmtUsd(12), fmtUsd(3_400_000_000)]).toEqual(["$13M", "$2.1M", "$850K", "$1.2K", "$12", "$3.4B"]);
  expect(clampText("  a \n\t b​c  ", 10)).toBe("a b c");
  expect(clampText("x".repeat(500), 5)).toBe("xxxxx…");
  expect(clampText(undefined, 5)).toBe("");
  expect(clampText(42, 5)).toBe("");
});

it("the section polls every 60 s, not every 3 s, and a run is stale after 2 hours", () => {
  expect(META_POLL_MS).toBe(60_000);
  expect(META_STALE_MS).toBe(2 * 3_600_000);
});

const counts = (tokens: number, creators: number, migrations: number) => ({ tokens, creators, migrations, migrationsAfter60s: 0 });
const row = (over: Record<string, unknown> = {}) => ({
  rank: 1,
  label: "Meta",
  firstSeenAt: ago(14 * 60),
  counts: { "6h": counts(5, 4, 0), "24h": counts(20, 10, 2) },
  createsPerMigration: 10 as number | null,
  topTokens: [] as Array<{ name: string; symbol: string; marketCapUsd?: number; url?: string }>,
  summary: "A line",
  ...over,
});

it("metaView: before the first run it waits; with a run and no rows it says none; after 2 hours it is stale (rows still shown)", () => {
  expect(metaView(null, NOW)).toMatchObject({ state: "waiting", rows: [], footer: null, note: "No Meta ranking yet. The worker computes it every 15 minutes." });
  expect(metaView({ computedAt: null, metas: [] }, NOW).state).toBe("waiting");
  expect(metaView({ computedAt: ago(3), metas: [] }, NOW)).toMatchObject({ state: "none", footer: "ranking from 3 minutes ago" });
  expect(metaView({ computedAt: ago(119), metas: [row()] }, NOW).state).toBe("ok");
  const stale = metaView({ computedAt: ago(3 * 60 + 5), metas: [row()] }, NOW);
  expect(stale).toMatchObject({ state: "stale", note: "The Meta ranking is stale (computed 3 hours ago).", footer: "ranking from 3 hours ago" });
  expect(stale.rows).toHaveLength(1);
  expect(metaView({ computedAt: ago(0), metas: [row()] }, NOW).footer).toBe("ranking computed just now");
});

it("metaView: shows at most the top 5 rows", () => {
  const rows = Array.from({ length: 9 }, (_, i) => row({ rank: i + 1, label: `M${i}` }));
  expect(metaView({ computedAt: ago(1), metas: rows }, NOW).rows.map((r) => r.label)).toEqual(["M0", "M1", "M2", "M3", "M4"]);
});

it("metaView: a row's numbers, trend, first seen and tokens", () => {
  const v = metaView(
    {
      computedAt: ago(1),
      metas: [row({ counts: { "6h": counts(140, 90, 4), "24h": { ...counts(312, 190, 15), migrationsAfter60s: 6 } }, createsPerMigration: 20.8, topTokens: [{ name: "woohao", symbol: "woohao", marketCapUsd: 13_000_000 }, { name: "咪好", symbol: "" }] })],
    },
    NOW,
  );
  expect(v.rows[0]).toEqual({
    rank: 1,
    label: "Meta",
    anchor: "meta-meta",
    numbers: ["312 tokens", "190 creators", "15 migrations (unfiltered)", "6 after 60 s", "21 creates per migration"],
    stripLine: "190 creators · 6 migrations after 60s",
    topCap: "$13M",
    trend: { word: "accelerating", text: "140 of 312 in the last 6 h" },
    firstSeen: "first seen 14 hours ago",
    tokens: [{ text: "woohao ($woohao) $13M", href: null }, { text: "咪好", href: null }],
    summary: "A line",
  });
});

it("metaView: absent or broken fields are left out, never shown as undefined or NaN", () => {
  const broken = {
    rank: 2,
    label: "Odd",
    firstSeenAt: "garbage",
    counts: { "6h": { tokens: Number.NaN, creators: 0, migrations: 0 }, "24h": { tokens: 7, creators: Number.NaN, migrations: 0 } },
    createsPerMigration: null,
    topTokens: [{ name: "", symbol: "" }, { name: "Solo", symbol: "SOLO", marketCapUsd: Number.NaN }],
    summary: "   ",
  };
  const v = metaView({ computedAt: ago(1), metas: [broken as never] }, NOW);
  expect(v.rows[0]).toEqual({ rank: 2, label: "Odd", anchor: "meta-odd", numbers: ["7 tokens", "0 migrations (unfiltered)"], stripLine: null, topCap: null, trend: null, firstSeen: null, tokens: [{ text: "Solo ($SOLO)", href: null }], summary: null });
  expect(JSON.stringify(v)).not.toMatch(/undefined|NaN/);
  const empty = metaView({ computedAt: ago(1), metas: [{ rank: 1, label: "Bare" } as never] }, NOW);
  expect(empty.rows[0]).toMatchObject({ label: "Bare", numbers: [], trend: null, tokens: [], summary: null });
});

it("metaView: a first seen time in the future reads 'just now'; zero launches in 24 h has no trend", () => {
  const v = metaView({ computedAt: ago(1), metas: [row({ firstSeenAt: ago(-30), counts: { "6h": counts(0, 0, 0), "24h": counts(0, 0, 0) }, createsPerMigration: null })] }, NOW);
  expect(v.rows[0]).toMatchObject({ firstSeen: "first seen just now", trend: null });
});

it("metaAnchor: letters and digits hyphenated, unicode kept, clamped, never empty", () => {
  expect(metaAnchor("GTA VI")).toBe("meta-gta-vi");
  expect(metaAnchor("  Ni Hao!! ")).toBe("meta-ni-hao");
  expect(metaAnchor("咪好")).toBe("meta-咪好");
  expect(metaAnchor("<img src=x onerror=alert(1)>")).toBe("meta-img-src-x-onerror-alert-1");
  expect(metaAnchor("!!!")).toBe("meta");
  expect(metaAnchor("")).toBe("meta");
  expect(metaAnchor("a".repeat(500))).toBe(`meta-${"a".repeat(40)}`);
});

it("metaView: repeated labels get numbered anchors, in rank order", () => {
  const v = metaView({ computedAt: ago(1), metas: [row({ rank: 1, label: "Cat" }), row({ rank: 2, label: "cat!" }), row({ rank: 3, label: "Cat" })] }, NOW);
  expect(v.rows.map((r) => r.anchor)).toEqual(["meta-cat", "meta-cat-2", "meta-cat-3"]);
});

it("metaView: options pick the row count and the ranked window the numbers come from; the trend stays 6 h of 24 h", () => {
  const rows = Array.from({ length: 9 }, (_, i) => row({ rank: i + 1, label: `M${i}`, counts: { "6h": counts(7, 3, 1), "24h": counts(20, 10, 2) } }));
  expect(metaView({ computedAt: ago(1), metas: rows }, NOW, { rows: 50 }).rows).toHaveLength(9);
  const six = metaView({ computedAt: ago(1), metas: rows }, NOW, { rows: 1, window: "6h" });
  expect(six.rows[0]!.numbers.slice(0, 3)).toEqual(["7 tokens", "3 creators", "1 migration (unfiltered)"]);
  expect(six.rows[0]!.trend!.text).toBe("7 of 20 in the last 6 h");
});

it("metaView: the strip line leaves out what the payload lacks", () => {
  const r = metaView({ computedAt: ago(1), metas: [row({ counts: { "6h": counts(1, 1, 0), "24h": { ...counts(20, 10, 2), migrationsAfter60s: 1 } } })] }, NOW).rows[0]!;
  expect(r.stripLine).toBe("10 creators · 1 migration after 60s");
  expect(r.topCap).toBeNull();
});

it("metaView: a token links only when the URL is http(s) without credentials", () => {
  const tok = (url: string) => ({ name: "T", symbol: "T", url });
  const v = metaView({ computedAt: ago(1), metas: [row({ topTokens: [tok("https://dexscreener.com/solana/abc"), tok("javascript:alert(1)"), tok("data:text/html,x"), tok("https://u:p@a.example/"), tok("")] })] }, NOW);
  expect(v.rows[0]!.tokens.map((t) => t.href)).toEqual(["https://dexscreener.com/solana/abc", null, null, null, null]);
});
