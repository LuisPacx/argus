import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { aCandidate, at } from "../testing/radar.ts";
import { tempDir } from "../testing/temp.ts";
import type { Lookalike } from "./types.ts";

const open = () => Datastore.open(path.join(tempDir("radar-cap-"), "argus.db"));

describe("the stored creates the local check reads (study.createsSince)", () => {
  it("returns the creates of the last 48 hours from every path, newest first, and leaves out other launchpads and rows with no create time", () => {
    const file = path.join(tempDir("radar-creates-"), "argus.db");
    const store = Datastore.open(file);
    const ev = (n: number, minutes: number, over: Record<string, string> = {}) => ({ kind: "create" as const, mint: `Mint${n}`.padEnd(40, "x") + "pump", receivedAt: at(minutes).toISOString(), signature: "", name: `Token ${n}`, symbol: `T${n}`, creator: `Creator${n}`, uri: `https://ipfs.io/ipfs/m${n}`, pool: "pump", ...over });
    store.study.recordTokenEvent(ev(1, -60));
    store.study.recordTokenEvent(ev(2, -30));
    store.study.recordTokenEvent(ev(3, -20, { pool: "bonk" })); // another launchpad: out of scope
    store.study.recordTokenEvent(ev(4, -50 * 60)); // older than the window
    store.study.recordTokenEvent({ ...ev(5, -10), kind: "migrate", name: "", symbol: "", creator: "" }); // a migrate with no create: no create time
    store.close();
    const raw = new DatabaseSync(file);
    const row = (mint: string, name: string, createdAt: string, source: string) =>
      raw.prepare("INSERT INTO study_tokens (mint, status, name, symbol, creator, created_at, first_seen_at, source) VALUES (?, 'chain', ?, 'CH', 'ChainCreator', ?, ?, ?)").run(mint, name, createdAt, at(-5).toISOString(), source);
    row("chainA", "Chain migrated", at(-90).toISOString(), "chain_migrated");
    row("chainB", "Chain sample", at(-120).toISOString(), "chain_sample");
    raw.close();
    const again = Datastore.open(file);
    const since = at(-48 * 60).toISOString();
    expect(again.study.createsSince(since, 100).map((r) => r.name)).toEqual(["Token 2", "Token 1", "Chain migrated", "Chain sample"]);
    expect(again.study.createsSince(since, 2).map((r) => r.name)).toEqual(["Token 2", "Token 1"]);
    expect(again.study.createsSince(since, 0)).toEqual([]);
    expect(again.study.createsSince(at(-25).toISOString(), 100)).toEqual([]); // first sightings of the pump rows are older than this
    again.close();
  });
});

describe("the row cap", () => {
  it("with 500 stored Trends the view has 30, highest score first, and the counts cover all 500", () => {
    const store = open();
    for (let i = 0; i < 500; i++) {
      const c = aCandidate(`Subject ${i}`, 2_000);
      store.radar.touchSeen(c.key, at(0));
      const id = store.radar.createTrend({ key: c.key, label: c.term, firstSeen: at(0).toISOString(), score: i, candidate: c });
      if (i % 100 === 0) store.radar.recordCheck(id, { side: "untokenized", trace: { at: at(1).toISOString(), phrases: [], live: [], lookalikes: [] }, localCreates: 0, localCreators: 0 }, at(1));
    }
    const view = store.radar.view(at(2));
    expect(view.trends).toHaveLength(30);
    expect(view.trends.map((t) => t.score)).toEqual(Array.from({ length: 30 }, (_, n) => 499 - n));
    expect(view.counts).toEqual({ shown: 500, untokenized: 5 });
    store.close();
  });

  it("with 80 lookalikes on one Trend the view returns 50 of them and says there are 80", () => {
    const store = open();
    for (let i = 0; i < 500; i++) {
      const c = aCandidate(`Subject ${i}`, 2_000);
      store.radar.touchSeen(c.key, at(0));
      const id = store.radar.createTrend({ key: c.key, label: c.term, firstSeen: at(0).toISOString(), score: i === 7 ? 1_000 : i % 90, candidate: c });
      if (i === 7) {
        const lookalikes: Lookalike[] = Array.from({ length: 80 }, (_, n) => ({ name: `Dead ${n}`, symbol: `D${n}`, url: "", marketCapUsd: 90_000, liquidityUsd: 1, createdAt: null, reason: "pool $1, cap $90K: drained or fake" }));
        store.radar.recordCheck(id, { side: "untokenized", trace: { at: at(1).toISOString(), phrases: [], live: [], lookalikes }, localCreates: 0, localCreators: 0 }, at(1));
      }
    }
    const view = store.radar.view(at(2));
    expect(view.trends).toHaveLength(30);
    expect(view.trends[0]).toMatchObject({ term: "Subject 7", score: 1_000, lookalikeCount: 80 });
    expect(view.trends[0]!.lookalikes).toHaveLength(50);
    expect(view.trends[0]!.lookalikes[0]!.name).toBe("Dead 0");
    for (const t of view.trends.slice(1)) expect(t.score).toBeLessThanOrEqual(89);
    const scores = view.trends.map((t) => t.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    store.close();
  });

  it("only Trends seen in the last 24 hours are listed", () => {
    const store = open();
    const c = aCandidate("Old news", 2_000);
    store.radar.touchSeen(c.key, at(0));
    store.radar.createTrend({ key: c.key, label: c.term, firstSeen: at(0).toISOString(), score: 20, candidate: c });
    expect(store.radar.view(at(23 * 60)).trends).toHaveLength(1);
    expect(store.radar.view(at(25 * 60)).trends).toHaveLength(0);
    expect(store.radar.view(at(25 * 60)).counts).toEqual({ shown: 0, untokenized: 0 });
    store.close();
  });
});
