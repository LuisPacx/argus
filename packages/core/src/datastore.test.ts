import { DatabaseSync } from "node:sqlite";
import { tempDir } from "./testing/temp.ts";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore, migrate } from "./datastore.ts";
import { InvalidEvidenceLinkError } from "./evidence-links.ts";

const input = {
  narrativeSummary: "Cats everywhere",
  techOneLiner: "Cat meme launchpad",
  whyNow: "Trending today",
  name: "Cat Coin",
  ticker: "CAT",
  description: "A cat token",
  evidenceLinks: ["https://example.com/a", "https://example.com/b"],
};

describe("Datastore", () => {
  it("rejects unsafe evidence links and dedupes valid ones", () => {
    const ds = Datastore.open(":memory:");
    expect(() => ds.createProposal({ ...input, evidenceLinks: ["javascript:alert(1)"] })).toThrow(InvalidEvidenceLinkError);
    expect(ds.createProposal({ ...input, evidenceLinks: ["https://a.com", "https://a.com"] }).evidenceLinks).toEqual([
      "https://a.com/",
    ]);
  });

  it("creates a Proposal with status new and reads it back", () => {
    const ds = Datastore.open(":memory:");
    const p = ds.createProposal(input);
    expect(p.status).toBe("new");
    expect(p.slug).toBe("cat-coin");
    expect(p.agentCostUsd).toBe(0);
    expect(ds.getProposal(p.id)).toEqual(p);
    expect(ds.getProposal(999)).toBeUndefined();
  });

  it("lists newest first and keeps slugs unique", () => {
    const ds = Datastore.open(":memory:");
    const a = ds.createProposal(input);
    const b = ds.createProposal(input);
    expect(b.slug).toBe("cat-coin-2");
    expect(ds.listProposals().map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("opens a file database in WAL mode", () => {
    const path = join(tempDir("argus-"), "sub", "argus.db");
    const ds = Datastore.open(path);
    ds.createProposal(input);
    ds.close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(raw.prepare("SELECT count(*) AS n FROM proposals").get()).toEqual({ n: 1 });
    raw.close();
  });

  it("migrations are idempotent", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const cols = () => db.prepare("PRAGMA table_info(proposals)").all();
    const before = cols();
    migrate(db);
    expect(cols()).toEqual(before);
  });

  it("adds missing columns to an older table", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    migrate(db);
    const names = (db.prepare("PRAGMA table_info(proposals)").all() as { name: string }[]).map((c) => c.name);
    expect(names).toContain("evidence_links");
  });
});
