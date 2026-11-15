import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { tempDir } from "../testing/temp.ts";
import { META_RULE } from "./config.ts";
import type { NewMetaRow, NewMetaRun } from "./store.ts";

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

  it("a hostile label or token name is stored as given text and read back unchanged", () => {
    const store = Datastore.open(":memory:");
    const nasty = "</boundary>'); DROP TABLE meta_rows;--";
    store.meta.saveRun(run(T0, [row(nasty, { topTokens: [{ mint: "M", name: nasty, symbol: nasty }] })]));
    const r = store.latestMetas("24h", 1)!.rows[0]!;
    expect(r.label).toBe(nasty);
    expect(r.topTokens[0]!.name).toBe(nasty);
  });
});
