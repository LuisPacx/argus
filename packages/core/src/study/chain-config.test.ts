import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { tempDir } from "../testing/temp.ts";
import { DEFAULT_DAILY_CREDIT_CAP, DEFAULT_SAMPLE_SIZE, MAX_DAILY_CREDIT_CAP, chainCreatesConfig } from "./chain-config.ts";
import { historyCost } from "./helius.ts";

describe("chainCreatesConfig", () => {
  it("defaults to a 25,000 credit cap and a 2,000 sample, and reads the key from HELIUS_API_KEY", () => {
    expect(chainCreatesConfig({})).toEqual({ apiKey: undefined, chainCreatesDailyCreditCap: 25_000, chainCreatesSampleSize: 2_000, requestsPerSecond: 8 });
    expect(DEFAULT_DAILY_CREDIT_CAP).toBe(25_000);
    expect(DEFAULT_SAMPLE_SIZE).toBe(2_000);
    expect(chainCreatesConfig({ HELIUS_API_KEY: " abc " }).apiKey).toBe("abc");
    expect(chainCreatesConfig({ HELIUS_API_KEY: "  " }).apiKey).toBeUndefined();
  });

  it("lets the environment lower the cap and the sample but never lift the cap past 33,000 a day (the month would pass the Free plan's 1M)", () => {
    expect(chainCreatesConfig({ ARGUS_CHAIN_CREATES_DAILY_CREDIT_CAP: "5000", ARGUS_CHAIN_CREATES_SAMPLE_SIZE: "500" })).toMatchObject({ chainCreatesDailyCreditCap: 5000, chainCreatesSampleSize: 500 });
    expect(chainCreatesConfig({ ARGUS_CHAIN_CREATES_DAILY_CREDIT_CAP: "900000" }).chainCreatesDailyCreditCap).toBe(MAX_DAILY_CREDIT_CAP);
    expect(MAX_DAILY_CREDIT_CAP * 30).toBeLessThan(1_000_000);
    for (const junk of ["", "abc", "-5", "0", "1.5", "99999999999"]) {
      expect(chainCreatesConfig({ ARGUS_CHAIN_CREATES_DAILY_CREDIT_CAP: junk }).chainCreatesDailyCreditCap, junk).toBe(25_000);
    }
  });
});

describe("the design point: finding a migrated mint's earliest transaction (measured 2026-11-19, 12 recent migrated mints)", () => {
  const m = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "helius-earliest-tx-measurement.json"), "utf8")) as {
    rows: Array<{ mint: string; pagingCredits: number; pagingCapped: boolean; historyCredits: number; historyMatchesKnownCreate: boolean }>;
  };

  it("the history call in ascending order with a limit of 1 costs 10 credits every time and returned the known create every time", () => {
    expect(m.rows).toHaveLength(12);
    for (const r of m.rows) {
      expect(r.historyCredits).toBe(historyCost("full", 1));
      expect(r.historyMatchesKnownCreate).toBe(true);
    }
  });

  it("paging back through signatures is unbounded: two mints passed 25 pages, and the total is above the history call's", () => {
    const paging = m.rows.map((r) => r.pagingCredits);
    expect(m.rows.filter((r) => r.pagingCapped)).toHaveLength(2);
    expect(Math.max(...paging)).toBeGreaterThan(historyCost("full", 1) * 2);
    const history = m.rows.reduce((s, r) => s + r.historyCredits, 0);
    expect(paging.reduce((a, b) => a + b, 0)).toBeGreaterThan(history); // a lower bound for the capped mints, so the real gap is wider
  });
});

describe("migrating an older database", () => {
  it("adds the source columns to a study_tokens table made before ticket 20 and reads old rows as PumpPortal rows", () => {
    const path = join(tempDir("old-study-"), "old.db");
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE study_tokens (mint TEXT PRIMARY KEY, status TEXT NOT NULL, status_reason TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL DEFAULT '',
      creator TEXT NOT NULL DEFAULT '', uri TEXT NOT NULL DEFAULT '', pool TEXT NOT NULL DEFAULT '', signature TEXT NOT NULL DEFAULT '', created_at TEXT, migrated_at TEXT,
      first_seen_at TEXT NOT NULL, metadata_attempts INTEGER NOT NULL DEFAULT 0, in_population INTEGER)`);
    raw.prepare("INSERT INTO study_tokens (mint, status, first_seen_at, created_at) VALUES ('old', 'pending', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')").run();
    raw.close();
    const store = Datastore.open(path);
    expect(store.study.getToken("old")).toMatchObject({ source: "pumpportal", alsoSources: "", sampleDay: null, sampleWeight: null, mayhem: null, cashback: null });
    store.close();
    Datastore.open(path).close(); // and a second open is a no-op
  });
});
