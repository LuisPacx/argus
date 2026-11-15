import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { tempDir } from "../testing/temp.ts";
import { META_RULE } from "./config.ts";
import type { CurrentMeta, NewMetaCurrent, NewMetaRow, NewMetaRun } from "./store.ts";

const DAY = 24 * 3_600_000;
const T0 = Date.parse("2026-11-11T20:00:00.000Z");

const row = (label: string, over: Partial<NewMetaRow> = {}): NewMetaRow => ({
  key: label.toLowerCase(),
  label,
  firstSeenAt: "2026-11-11T10:00:00.000Z",
  counts: { "6h": { tokens: 4, creators: 3, migrations: 1, migrationsAfter60s: 0 }, "24h": { tokens: 10, creators: 6, migrations: 2, migrationsAfter60s: 1 } },
  topTokens: [{ mint: "MintA", name: label, symbol: "SYM" }],
  ...over,
});

const run = (atMs: number, rows24: NewMetaRow[] = [row("A"), row("B")], over: Partial<NewMetaRun> = {}): NewMetaRun => ({
  computedAt: new Date(atMs).toISOString(),
  note: "a note",
  rule: META_RULE,
  dexCalls: 2,
  dexFailures: 1,
  base: { "6h": { tokens: 100, migrations: 20 }, "24h": { tokens: 400, migrations: 40 } },
  rows: { "6h": [row("A")], "24h": rows24 },
  ...over,
});

const tables = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'meta_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  db.close();
  return names;
};

describe("meta persistence", () => {
  it("the migration is additive and idempotent: a second open changes nothing, and a database without the tables gets them", () => {
    const path = join(tempDir("meta-migrate-"), "argus.db");
    const first = Datastore.open(path);
    first.meta.saveRun(run(T0));
    first.close();
    const before = tables(path);
    expect(before).toEqual(expect.arrayContaining(["meta_rows", "meta_runs"]));
    const second = Datastore.open(path);
    expect(second.latestMetas("24h", 10)?.rows).toHaveLength(2);
    second.close();
    expect(tables(path)).toEqual(before);

    // An older database (the live one before this ticket): study data, no meta tables.
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE meta_rows");
    raw.exec("DROP TABLE meta_runs");
    raw.close();
    const third = Datastore.open(path);
    expect(third.latestMetas("24h", 10)).toBeUndefined();
    third.close();
    expect(tables(path)).toEqual(before);
  });

  it("stores a run and latestMetas returns the newest run, per window, ranked, cut to the limit", () => {
    const store = Datastore.open(":memory:");
    expect(store.latestMetas("24h", 10)).toBeUndefined();
    store.meta.saveRun(run(T0 - 3_600_000, [row("Old")]));
    store.meta.saveRun(run(T0, [row("First"), row("Second", { marketCapUsd: 5_000_000, topMarketCapUsd: 4_000_000, topTokens: [{ mint: "M1", name: "Second", symbol: "SEC", marketCapUsd: 4_000_000 }] }), row("Third")]));
    const latest = store.latestMetas("24h", 2)!;
    expect(latest.computedAt).toBe(new Date(T0).toISOString());
    expect(latest.window).toBe("24h");
    expect(latest.rows.map((r) => [r.rank, r.label])).toEqual([[1, "First"], [2, "Second"]]);
    expect(latest.rows[1]).toMatchObject({ marketCapUsd: 5_000_000, topMarketCapUsd: 4_000_000, topTokens: [{ mint: "M1", symbol: "SEC", marketCapUsd: 4_000_000 }] });
    expect(latest.rows[0]!.marketCapUsd).toBeUndefined();
    expect(latest.rows[0]!.topTokens[0]).toEqual({ mint: "MintA", name: "First", symbol: "SYM" });
    expect(latest).toMatchObject({ dexCalls: 2, dexFailures: 1, note: "a note", windowTokens: 400, windowMigrations: 40 });
    expect(latest.baseMigrationRate).toBeCloseTo(0.1);
    expect(store.latestMetas("6h", 10)!.baseMigrationRate).toBeCloseTo(0.2);
    expect(store.latestMetas("6h", 10)!.rows.map((r) => r.label)).toEqual(["A"]);
  });

  it("attaches a stored summary only while the row is close to the counts it was written from (ticket 06), and a pre-ticket row with no counts is stale", () => {
    const path = join(tempDir("meta-stale-"), "argus.db");
    const store = Datastore.open(path);
    store.meta.saveRun(run(T0, [row("A"), row("B"), row("C"), row("D")])); // each row: 10 tokens, 6 creators in 24 h
    const at = new Date(T0 + 60_000).toISOString();
    store.meta.saveSummary("a", "written for ten times the row", "h", at, { tokens: 105, creators: 64 });
    store.meta.saveSummary("b", "written for about the row", "h", at, { tokens: 8, creators: 5 });
    store.meta.saveSummary("c", "written two days ago", "h", new Date(T0 - 2 * DAY).toISOString(), { tokens: 10, creators: 6 });
    store.meta.saveSummary("d", "written before ticket 06", "h", at, { tokens: 10, creators: 6 });
    store.close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE meta_summaries SET base_tokens = NULL, base_creators = NULL WHERE key = 'd'");
    db.close();
    const again = Datastore.open(path);
    const rows = again.meta.latest("24h", 10, at)!.rows;
    expect(rows.map((r) => r.summary)).toEqual([undefined, "written for about the row", undefined, undefined]);
    expect(again.meta.summaries(["d"]).get("d")).toMatchObject({ baseTokens: null, baseCreators: null }); // the record is kept, only hidden
    again.close();
  });

  it("derives migrationRate and createsPerMigration for the ranked window from the stored counts", () => {
    const store = Datastore.open(":memory:");
    store.meta.saveRun(run(T0, [row("A"), row("Dud", { counts: { "6h": { tokens: 3, creators: 3, migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens: 3, creators: 3, migrations: 0, migrationsAfter60s: 0 } } })]));
    const [a, dud] = store.latestMetas("24h", 10)!.rows;
    expect(a).toMatchObject({ migrationRate: 0.2, createsPerMigration: 5 });
    expect(dud).toMatchObject({ migrationRate: 0, createsPerMigration: null });
    expect(store.latestMetas("6h", 10)!.rows[0]).toMatchObject({ migrationRate: 0.25, createsPerMigration: 4 });
  });

  it("prunes runs older than 14 days (with their rows) when a new run is saved, and keeps newer ones", () => {
    const path = join(tempDir("meta-prune-"), "argus.db");
    const store = Datastore.open(path);
    store.meta.saveRun(run(T0 - 20 * DAY));
    store.meta.saveRun(run(T0 - 15 * DAY));
    store.meta.saveRun(run(T0 - 13 * DAY));
    store.meta.saveRun(run(T0));
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    const times = (db.prepare("SELECT computed_at FROM meta_runs ORDER BY id").all() as { computed_at: string }[]).map((r) => Date.parse(r.computed_at));
    const orphans = (db.prepare("SELECT COUNT(*) AS n FROM meta_rows WHERE run_id NOT IN (SELECT id FROM meta_runs)").get() as { n: number }).n;
    const rowCount = (db.prepare("SELECT COUNT(*) AS n FROM meta_rows").get() as { n: number }).n;
    db.close();
    expect(times).toEqual([T0 - 13 * DAY, T0]);
    expect(orphans).toBe(0);
    expect(rowCount).toBe(2 * 3); // two runs, each 2 rows in 24h plus 1 in 6h
  });

  it("stores the Metas and Watching subjects of a run (meta_current) and reads the newest run's back with counts; the launch-theme rows are untouched", () => {
    const store = Datastore.open(":memory:");
    expect(store.currentMetas()).toBeUndefined();
    const metaRow = (key: string, cap: number, over: Partial<CurrentMeta> = {}): CurrentMeta => ({
      key,
      label: key.toUpperCase(),
      leader: { mint: `Mint${key}`, name: `${key} the token`, symbol: key.toUpperCase(), marketCapUsd: cap, createdAt: "2026-11-14T10:00:00.000Z", source: "trending", stale: false },
      holding: false,
      enteredAt: "2026-11-15T09:00:00.000Z",
      counts: row("A").counts,
      topTokens: [{ mint: "MintA", name: "A", symbol: "SYM", marketCapUsd: cap }],
      ...over,
    });
    const plain = run(T0);
    const first = store.meta.saveRun(plain);
    expect(store.currentMetas()).toEqual({ runId: first, computedAt: plain.computedAt, metas: [], watching: [] });

    const current = { metas: [metaRow("jensen", 2_100_000), metaRow("gta6", 800_000, { holding: true })], watching: [metaRow("ni", 96_000, { leader: { mint: "MintNi", name: "n", symbol: "N", marketCapUsd: 96_000, source: "theme", stale: true } })] };
    const second = store.meta.saveRun(run(T0 + 15 * 60_000, [row("A"), row("B")], { current }));
    const read = store.currentMetas()!;
    expect(read).toMatchObject({ runId: second, computedAt: new Date(T0 + 15 * 60_000).toISOString() });
    expect(read.metas).toEqual(current.metas);
    expect(read.watching).toEqual(current.watching);
    expect(read.metas[1]).toMatchObject({ holding: true, counts: { "24h": { creators: 6 } } });
    // as-of reads the newest run at or before the time
    expect(store.currentMetas(new Date(T0 + 60_000).toISOString())).toMatchObject({ runId: first, metas: [] });
    // the launch-theme rows are exactly what a run without `current` stores
    expect(store.latestMetas("24h", 10)!.rows.map((r) => r.label)).toEqual(["A", "B"]);
  });

  it("meta_current rows are pruned with their run", () => {
    const path = join(tempDir("meta-current-prune-"), "argus.db");
    const store = Datastore.open(path);
    const cur: NewMetaCurrent = { metas: [{ key: "k", label: "K", leader: { mint: "M", name: "n", symbol: "S", marketCapUsd: 1_500_000, source: "theme", stale: false }, holding: false, enteredAt: "2026-11-01T00:00:00.000Z", counts: row("K").counts, topTokens: [] }], watching: [] };
    store.meta.saveRun(run(T0 - 20 * DAY, [row("A")], { current: cur }));
    store.meta.saveRun(run(T0, [row("A")], { current: cur }));
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM meta_current").get() as { n: number }).n;
    const orphans = (db.prepare("SELECT COUNT(*) AS n FROM meta_current WHERE run_id NOT IN (SELECT id FROM meta_runs)").get() as { n: number }).n;
    db.close();
    expect([n, orphans]).toEqual([1, 0]);
  });

  it("the meta_current migration is additive and idempotent, and an older database without the table gets it", () => {
    const path = join(tempDir("meta-current-migrate-"), "argus.db");
    Datastore.open(path).close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE meta_current");
    raw.close();
    const reopened = Datastore.open(path);
    reopened.meta.saveRun(run(T0));
    expect(reopened.currentMetas()).toMatchObject({ metas: [], watching: [] });
    reopened.close();
    const again = Datastore.open(path);
    expect(again.currentMetas()).toMatchObject({ metas: [], watching: [] });
    again.close();
    expect(tables(path)).toContain("meta_current");
  });

  it("reads the dexscreener:trending Signals first seen in a window, newest first, and no other Source's", () => {
    const store = Datastore.open(":memory:");
    const sig = (id: string, sourceId: string) => ({ id, sourceId, sourceLabel: "x", title: id, summary: "s", url: "", publishedAt: "2026-11-01T00:00:00.000Z" });
    store.recordSignals([sig("dexscreener:trending:solana:old", "dexscreener:trending")], new Date("2026-11-14T00:00:00.000Z"));
    store.recordSignals([sig("dexscreener:trending:solana:a", "dexscreener:trending"), sig("rss:1", "rss:bbc")], new Date("2026-11-15T10:00:00.000Z"));
    store.recordSignals([sig("dexscreener:trending:solana:b", "dexscreener:trending")], new Date("2026-11-15T11:00:00.000Z"));
    store.recordSignals([sig("dexscreener:trending:solana:later", "dexscreener:trending")], new Date("2026-11-15T20:00:00.000Z"));
    const rows = store.meta.trendingSignals("2026-11-14T12:00:00.000Z", "2026-11-15T15:00:00.000Z");
    expect(rows.map((r) => r.id)).toEqual(["dexscreener:trending:solana:b", "dexscreener:trending:solana:a"]);
  });

  it("a hostile label or token name is stored as given text and read back unchanged", () => {
    const store = Datastore.open(":memory:");
    const nasty = "</boundary>'); DROP TABLE meta_rows;--";
    store.meta.saveRun(run(T0, [row(nasty, { topTokens: [{ mint: "M", name: nasty, symbol: nasty }] })]));
    const r = store.latestMetas("24h", 1)!.rows[0]!;
    expect(r.label).toBe(nasty);
    expect(r.topTokens[0]!.name).toBe(nasty);
  });
});
