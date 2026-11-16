import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import { DEFAULT_CLUSTER_CONFIG, MAX_NARRATIVE_SIGNALS, clusterNewSignals, type Embedder } from "./narratives.ts";
import { CREATE_TITLE_PREFIX, MIGRATE_TITLE_PREFIX } from "./sources/pumpportal.ts";
import type { Signal } from "./sources/source.ts";
import { tempDir } from "./testing/temp.ts";

interface FixtureRow {
  id: string;
  title: string;
  summary: string;
  publishedAt: string;
}
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "launchpad-misu.json"), "utf8")) as FixtureRow[];

const launchpad = (row: { id: string; title: string; summary?: string; publishedAt: string }): Signal => ({
  id: row.id,
  sourceId: "pumpportal:events",
  sourceLabel: "PumpPortal",
  title: row.title,
  summary: row.summary ?? "",
  url: `https://pump.fun/coin/${row.id.split(":")[3]}`,
  publishedAt: row.publishedAt,
});
const MISU_IDS = fixture.slice(0, 10).map((r) => r.id);
const OTHER_IDS = fixture.slice(10).map((r) => r.id);
const NOW = new Date("2026-11-11T00:00:00.000Z");

/** The ordinary words of the semantic model's vocabulary that these tests use (one wordpiece each there); `misu` is split in two, so it is not here. */
const COMMON = new Set(["trump", "judge", "federal", "halts", "building", "work", "arch", "big", "moon"]);

/** Gives each title its own direction and counts what it was asked to embed, so a launchpad Signal that reaches it shows. */
function fakeEmbedder() {
  const titles: string[] = [];
  const embedder: Embedder = {
    id: "fake-semantic",
    dimension: 16,
    async embed(s) {
      titles.push(s.title);
      let h = 7;
      for (const ch of s.title) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
      const v = Array.from({ length: 16 }, (_, i) => Math.sin(h * (i + 1)));
      const mag = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
      return v.map((x) => x / mag);
    },
    isCommonWord: (w) => COMMON.has(w),
  };
  return { embedder, titles };
}

/** The Narratives as lists of Signal ids, biggest first. */
function narrativesOf(ds: Datastore): string[][] {
  return ds
    .listNarratives(10_000)
    .map((n) =>
      ds
        .getNarrative(n.id)!
        .signals.map((s) => s.id)
        .sort(),
    )
    .sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));
}
const narrativeHolding = (groups: string[][], id: string) => groups.find((g) => g.includes(id)) ?? [];

describe("the Misu fixture (the real Signals of 2026-11-08..11-10)", () => {
  async function run(extra: Signal[] = []) {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([...fixture.map(launchpad), ...extra], new Date("2026-11-11T00:00:00.000Z"));
    const { embedder, titles } = fakeEmbedder();
    await clusterNewSignals(ds, embedder, { now: NOW });
    return { ds, titles, groups: narrativesOf(ds) };
  }

  it("puts the 9 Misu creates and the bond in one Narrative that holds nothing else", async () => {
    const { groups } = await run();
    expect(narrativeHolding(groups, MISU_IDS[0]!)).toEqual([...MISU_IDS].sort());
    for (const id of OTHER_IDS) expect(narrativeHolding(groups, id)).not.toContain(MISU_IDS[0]);
  });

  it("never embeds a launchpad Signal: the template cannot become a centroid", async () => {
    const { titles } = await run();
    expect(titles).toEqual([]);
  });

  it("names the Narrative after the token, not after the template, and records it as a launchpad one", async () => {
    const { ds } = await run();
    const misu = ds.listNarratives(100).find((n) => n.title.includes("MISU"));
    expect(misu?.title).toBe("米苏 ($MISU)");
    expect(misu?.signalCount).toBe(10);
  });

  it("the same-name copycats among the other creates group too, each name apart from Misu", async () => {
    const { groups } = await run();
    const strike = fixture.filter((r) => /Crypto ?Strike/i.test(r.title)).map((r) => r.id);
    expect(narrativeHolding(groups, strike[0]!)).toEqual([...strike].sort()); // `Crypto Strike ($CS)` x6 and `CRYPTOSTRIKE ($CS)` meet through the ticker
    expect(groups.some((g) => g.some((id) => MISU_IDS.includes(id)) && g.some((id) => strike.includes(id)))).toBe(false);
  });

  it("a social Signal that names the subject joins the Misu Narrative; one that does not, does not", async () => {
    // Measured on the DB copy of 2026-11-14 (docs/adr/0007, amendment): `misu` is two wordpieces in the model's vocabulary, so it is not an
    // ordinary word, and it appears in 1 recent headline (the cut is 5); `moon`, `zero`, `poland` are single pieces and never link.
    const named: Signal = { id: "rss:test:misu", sourceId: "rss:test", sourceLabel: "Test", title: "Sea lion Misu TikTok videos go viral in China", summary: "", url: "", publishedAt: "2026-11-10T23:30:00.000Z" };
    const other: Signal = { ...named, id: "rss:test:arch", title: "Federal judge halts building work on Trump's triumphal arch" };
    const { groups } = await run([named, other]);
    expect(narrativeHolding(groups, "rss:test:misu")).toEqual([...MISU_IDS, "rss:test:misu"].sort());
    expect(narrativeHolding(groups, "rss:test:arch")).toEqual(["rss:test:arch"]);
  });

  it("a headline joins only by a phrase it carries, and only when the lexical embedder's missing vocabulary test is present", async () => {
    const named: Signal = { id: "rss:test:misu", sourceId: "rss:test", sourceLabel: "Test", title: "Sea lion Misu TikTok videos go viral in China", summary: "", url: "", publishedAt: "2026-11-10T23:30:00.000Z" };
    const ds = Datastore.open(":memory:");
    ds.recordSignals([...fixture.map(launchpad), named], NOW);
    const { embedder } = fakeEmbedder();
    await clusterNewSignals(ds, { ...embedder, isCommonWord: undefined }, { now: NOW });
    expect(narrativeHolding(narrativesOf(ds), "rss:test:misu")).toEqual(["rss:test:misu"]);
  });

  it("a DexScreener token with the Misu name joins the Misu Narrative (a market Signal, same token keys), an unrelated one does not", async () => {
    const dex = (id: string, title: string): Signal => ({ id, sourceId: "dexscreener:trending", sourceLabel: "DexScreener", title, summary: "", url: "", publishedAt: "2026-11-10T23:40:00.000Z" });
    const { groups } = await run([dex("dexscreener:trending:solana:A", "Misu ($MISU)"), dex("dexscreener:trending:solana:B", "Poppy ($POPPY)")]);
    expect(narrativeHolding(groups, "dexscreener:trending:solana:A")).toContain(MISU_IDS[0]);
    expect(narrativeHolding(groups, "dexscreener:trending:solana:B")).toEqual(["dexscreener:trending:solana:B"]);
  });
});

describe("a common word does not link", () => {
  it("Big Coin, AI Coin and Trump Coin copycats stay three Narratives, and a headline about big AI coin and Trump joins none", async () => {
    const copies = (name: string, ticker: string) => [1, 2, 3].map((i) => launchpad({ id: `pumpportal:events:create:${ticker}${i}`, title: `${CREATE_TITLE_PREFIX}${name} ($${ticker})`, publishedAt: `2026-11-10T10:0${i}:00.000Z` }));
    const headline: Signal = { id: "rss:test:bigai", sourceId: "rss:test", sourceLabel: "Test", title: "Why big AI coin and Trump are trending", summary: "", url: "", publishedAt: "2026-11-10T12:00:00.000Z" };
    const ds = Datastore.open(":memory:");
    ds.recordSignals([...copies("Big Coin", "BIGC"), ...copies("AI Coin", "AIC"), ...copies("Trump Coin", "TRUMPC"), headline], NOW);
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    const groups = narrativesOf(ds);
    expect(groups.map((g) => g.length).sort()).toEqual([1, 3, 3, 3]);
    expect(narrativeHolding(groups, "rss:test:bigai")).toEqual(["rss:test:bigai"]);
  });

  it("a coined word that many recent headlines carry is no longer a distinctive token: past the document-frequency cut it links nothing", async () => {
    const zorbex = [1, 2, 3].map((i) => launchpad({ id: `pumpportal:events:create:Zorb${i}`, title: `${CREATE_TITLE_PREFIX}Zorbex ($ZORB)`, publishedAt: `2026-11-10T10:0${i}:00.000Z` }));
    const headlines = (n: number): Signal[] =>
      Array.from({ length: n }, (_, i) => ({ id: `rss:test:z${i}`, sourceId: "rss:test", sourceLabel: "Test", title: `Talk of the Zorbex number ${i} grows`, summary: "", url: "", publishedAt: `2026-11-10T12:0${i}:00.000Z` }));
    const run = async (n: number) => {
      const ds = Datastore.open(":memory:");
      ds.recordSignals([...zorbex, ...headlines(n)], NOW);
      await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
      return narrativesOf(ds);
    };
    expect(narrativeHolding(await run(DEFAULT_CLUSTER_CONFIG.crossMaxDocFreq), "rss:test:z0")).toHaveLength(8); // 5 headlines carry it, which is within the cut: all of them join the 3 creates
    expect(narrativeHolding(await run(DEFAULT_CLUSTER_CONFIG.crossMaxDocFreq + 1), "rss:test:z0")).toEqual(["rss:test:z0"]); // 6: over it
  });

  it("the document-frequency count reads the whole headline and folds apostrophes, so the headline itself and a phrase late in a long title are counted", async () => {
    const ds = Datastore.open(":memory:");
    const headline = (i: number, title: string): Signal => ({ id: `rss:test:df${i}`, sourceId: "rss:test", sourceLabel: "Test", title, summary: "", url: "", publishedAt: "2026-11-10T12:00:00.000Z" });
    ds.recordSignals([headline(1, "Don't buy AR glasses"), ...[2, 3, 4].map((i) => headline(i, `Local council members spent an entire evening debating zoning rules and then Zorbex number ${i} grows`))], NOW);
    const since = "2026-11-08T00:00:00.000Z";
    expect(ds.recentPhraseCount("dont buy", since)).toBe(1);
    expect(ds.recentPhraseCount("zorbex", since)).toBe(3); // the phrase sits after character 64 of each title
  });

  it("a bond does not revive a Narrative that has lapsed: it takes its create's name and goes where that name goes now", async () => {
    const ds = Datastore.open(":memory:");
    const create = launchpad({ id: "pumpportal:events:create:Lapse0001", title: `${CREATE_TITLE_PREFIX}Zebra Dust ($ZD)`, publishedAt: "2026-11-07T10:00:00.000Z" });
    ds.recordSignals([create], new Date("2026-11-07T10:05:00.000Z"));
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: new Date("2026-11-07T10:05:00.000Z") });
    const later = new Date("2026-11-11T00:00:00.000Z"); // more than 72 h on
    ds.recordSignals([launchpad({ id: "pumpportal:events:migrate:Lapse0001", title: `${MIGRATE_TITLE_PREFIX}Laps...0001`, publishedAt: "2026-11-10T23:00:00.000Z" })], later);
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: later });
    expect(narrativesOf(ds).map((g) => g.length)).toEqual([1, 1]);
  });

  it("a name that is only generic words (Coin, Meme, AI) stands alone each time, and joins nothing", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals(
      ["Coin ($COIN)", "Coin ($COIN)", "MEME ($MEME)", "AI ($AI)"].map((t, i) => launchpad({ id: `pumpportal:events:create:G${i}`, title: `${CREATE_TITLE_PREFIX}${t}`, publishedAt: `2026-11-10T10:0${i}:00.000Z` })),
      NOW,
    );
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    expect(narrativesOf(ds).map((g) => g.length)).toEqual([1, 1, 1, 1]);
  });

  it("a name with a generic ticker still joins by its name", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals(
      ["Poppy ($COIN)", "Poppy ($MEME)", "POPPY ($AI)"].map((t, i) => launchpad({ id: `pumpportal:events:create:P${i}`, title: `${CREATE_TITLE_PREFIX}${t}`, publishedAt: `2026-11-10T10:0${i}:00.000Z` })),
      NOW,
    );
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    expect(narrativesOf(ds).map((g) => g.length)).toEqual([3]);
  });
});

describe("a bond follows its create", () => {
  const BOND = (mint: string, at = "2026-11-10T12:00:00.000Z") => launchpad({ id: `pumpportal:events:migrate:${mint}`, title: `${MIGRATE_TITLE_PREFIX}${mint.slice(0, 4)}...${mint.slice(-4)}`, publishedAt: at });
  const CREATE = (mint: string, title: string, at = "2026-11-10T10:00:00.000Z") => launchpad({ id: `pumpportal:events:create:${mint}`, title: `${CREATE_TITLE_PREFIX}${title}`, publishedAt: at });

  it("joins its create's Narrative whatever the script of the name", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([CREATE("MintAAAA1111", "咪好 ($NIHAO)"), CREATE("MintBBBB2222", "咪好 ($NIHAO)"), BOND("MintBBBB2222"), CREATE("MintCCCC3333", "Zebra Dust ($ZD)"), BOND("MintCCCC3333")], NOW);
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    const groups = narrativesOf(ds);
    expect(narrativeHolding(groups, "pumpportal:events:migrate:MintBBBB2222")).toEqual(["pumpportal:events:create:MintAAAA1111", "pumpportal:events:create:MintBBBB2222", "pumpportal:events:migrate:MintBBBB2222"]);
    expect(narrativeHolding(groups, "pumpportal:events:migrate:MintCCCC3333")).toEqual(["pumpportal:events:create:MintCCCC3333", "pumpportal:events:migrate:MintCCCC3333"]);
  });

  it("with no known create it stands alone: no thematic Narrative takes it, and a run of them seeds no bin", async () => {
    const ds = Datastore.open(":memory:");
    const bonds = Array.from({ length: 40 }, (_, i) => BOND(`Unknown${String(i).padStart(4, "0")}xxxx`, `2026-11-10T12:${String(i).padStart(2, "0")}:00.000Z`));
    ds.recordSignals([CREATE("MintAAAA1111", "Zebra Dust ($ZD)"), CREATE("MintAAAA1112", "Zebra Dust ($ZD)"), ...bonds], NOW);
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    const groups = narrativesOf(ds);
    expect(groups[0]).toEqual(["pumpportal:events:create:MintAAAA1111", "pumpportal:events:create:MintAAAA1112"]);
    expect(groups.slice(1).every((g) => g.length === 1)).toBe(true);
    expect(groups).toHaveLength(41);
  });

  it("a bond whose create predates the Signals takes the name and ticker the Study recorded", async () => {
    const ds = Datastore.open(":memory:");
    const mint = "OldMint9999AAAA";
    ds.study.recordTokenEvent({ kind: "create", mint, receivedAt: "2026-11-09T00:00:00.000Z", signature: "", name: "Zebra Dust", symbol: "ZD", creator: "", uri: "", pool: "pump" });
    ds.recordSignals([CREATE("MintAAAA1111", "Zebra Dust ($ZD)"), CREATE("MintAAAA1112", "Zebra Dust ($ZD)"), BOND(mint)], NOW);
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    expect(narrativeHolding(narrativesOf(ds), `pumpportal:events:migrate:${mint}`)).toHaveLength(3);
  });

  it("a bond whose create sits in an old catch-all Narrative does not join it, it follows the create's name instead", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([CREATE("MintAAAA1111", "Zebra Dust ($ZD)", "2026-11-10T09:00:00.000Z"), CREATE("MintBBBB2222", "Zebra Dust ($ZD)"), BOND("MintAAAA1111")], NOW);
    // The first create is already in a pre-ticket Narrative (kind news, as every old row is).
    const first = ds.unclusteredSignals(1)[0]!;
    ds.createNarrative(first, [1, 0], "2026-11-10T09:00:00.000Z", { id: "fake-semantic", dimension: 16 });
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    const groups = narrativesOf(ds);
    expect(narrativeHolding(groups, "pumpportal:events:migrate:MintAAAA1111")).toEqual(["pumpportal:events:create:MintBBBB2222", "pumpportal:events:migrate:MintAAAA1111"]);
    expect(narrativeHolding(groups, "pumpportal:events:create:MintAAAA1111")).toEqual(["pumpportal:events:create:MintAAAA1111"]);
  });
});

describe("no Narrative absorbs the stream", () => {
  it("holds at most maxNarrativeSignals Signals: the next same-name create starts a successor, which later ones join", async () => {
    const N = DEFAULT_CLUSTER_CONFIG.maxNarrativeSignals;
    expect(N).toBe(MAX_NARRATIVE_SIGNALS);
    const ds = Datastore.open(":memory:");
    const creates = Array.from({ length: N + 3 }, (_, i) =>
      launchpad({ id: `pumpportal:events:create:Flood${String(i).padStart(6, "0")}`, title: `${CREATE_TITLE_PREFIX}Floodcoin ($FLOOD)`, publishedAt: new Date(NOW.getTime() - 3_600_000 + i * 100).toISOString() }),
    );
    ds.recordSignals(creates, NOW);
    for (let pass = 0; pass < 10 && ds.unclusteredSignals(1).length > 0; pass++) await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    expect(narrativesOf(ds).map((g) => g.length)).toEqual([N, 3]);
  });

  it("applies to news Narratives too: a full one is not joined even by an identical headline", async () => {
    const ds = Datastore.open(":memory:");
    const same = (i: number): Signal => ({ id: `rss:t:${i}`, sourceId: "rss:t", sourceLabel: "T", title: "One story", summary: "", url: "", publishedAt: `2026-11-10T10:0${i}:00.000Z` });
    ds.recordSignals([same(1), same(2), same(3), same(4)], NOW);
    await clusterNewSignals(ds, { id: "same", dimension: 2, embed: async () => [1, 0] }, { now: NOW, config: { maxNarrativeSignals: 2 } });
    expect(narrativesOf(ds).map((g) => g.length)).toEqual([2, 2]);
  });
});

describe("no template attractor", () => {
  /** A deterministic stream of distinct pronounceable names. */
  function names(n: number): string[] {
    let s = 12345;
    const next = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0);
    const syl = ["ba", "ko", "ri", "zu", "me", "to", "la", "vex", "no", "qui", "sha", "dro"];
    const out = new Set<string>();
    while (out.size < n) out.add(Array.from({ length: 3 + (next() % 3) }, () => syl[next() % syl.length]!).join("") + (out.size % 97));
    return [...out];
  }

  it("1,000 distinct creates from the real title template: no Narrative holds more than 5% of them", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals(
      names(1000).map((name, i) => launchpad({ id: `pumpportal:events:create:Rnd${String(i).padStart(5, "0")}`, title: `${CREATE_TITLE_PREFIX}${name} ($${name.slice(0, 4).toUpperCase()}${i})`, summary: `${name} was just launched.`, publishedAt: new Date(NOW.getTime() - 3_600_000 + i * 1000).toISOString() })),
      NOW,
    );
    // An embedder in which the template dominates every title, as the real model does (0.956 to 0.972 against the template centroid, whatever the name).
    const template: Embedder = {
      id: "template-dominated",
      dimension: 4,
      async embed(s) {
        const wiggle = (s.title.length % 7) / 100;
        const v = [1, wiggle, 0, 0];
        const mag = Math.hypot(...v);
        return v.map((x) => x / mag);
      },
    };
    for (let pass = 0; pass < 5; pass++) await clusterNewSignals(ds, template, { now: NOW });
    const sizes = narrativesOf(ds).map((g) => g.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
  });
});

describe("DexScreener tokens never found a news Narrative (proposal-routing ticket 05)", () => {
  const dex = (id: string, title: string, publishedAt = "2026-11-10T23:40:00.000Z"): Signal => ({ id: `dexscreener:trending:solana:${id}`, sourceId: "dexscreener:trending", sourceLabel: "DexScreener", title, summary: "", url: "", publishedAt });
  const kinds = (ds: Datastore) => ds.listNarratives(100).map((n) => ds.narrativeKind(n.id));

  it("a pass over several tokens and no headlines creates no news Narrative: a token that matches nothing starts a launchpad-kind one, a second token of its name joins it, a token with no usable key stands alone", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([dex("A", "Poppy ($POPPY)"), dex("B", "Poppy ($PUP)"), dex("C", "Rex ($REX)"), dex("D", "Coin ($COIN)"), dex("E", "!!!")], NOW);
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    const ids = ds.listNarratives(100).map((n) => ds.getNarrative(n.id)!.signals.map((s) => s.id).sort());
    expect(kinds(ds).every((k) => k === "launchpad")).toBe(true);
    expect(ids.filter((g) => g.length === 2)).toEqual([["dexscreener:trending:solana:A", "dexscreener:trending:solana:B"]]);
    expect(ids).toHaveLength(4);
    expect(ds.listNarratives(100).find((n) => n.title === "Poppy ($POPPY)")).toBeDefined();
  });

  it("a token near an existing news Narrative still joins it, and a later token of the same name then joins that one", async () => {
    const ds = Datastore.open(":memory:");
    const headline: Signal = { id: "rss:test:poppy", sourceId: "rss:test", sourceLabel: "Test", title: "Poppy ($POPPY)", summary: "", url: "", publishedAt: "2026-11-10T20:00:00.000Z" };
    ds.recordSignals([headline, dex("A", "Poppy ($POPPY)")], NOW);
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    expect(narrativesOf(ds)).toEqual([["dexscreener:trending:solana:A", "rss:test:poppy"]]);
    expect(kinds(ds)).toEqual(["news"]);
  });

  it("leaves the Meta reader alone: every token is still a Signal in the store", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([dex("A", "Poppy ($POPPY)"), dex("B", "Rex ($REX)")], NOW);
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    expect(ds.unclusteredSignals(100)).toEqual([]);
    expect(narrativesOf(ds).flat().sort()).toEqual(["dexscreener:trending:solana:A", "dexscreener:trending:solana:B"]);
  });
});

describe("legacy Narratives and the migration", () => {
  it("a launchpad create never joins a Narrative built before the ticket, even one its embedder would match", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([launchpad({ id: "pumpportal:events:create:Old00001", title: `${CREATE_TITLE_PREFIX}Zebra Dust ($ZD)`, publishedAt: "2026-11-10T09:00:00.000Z" })], NOW);
    ds.createNarrative(ds.unclusteredSignals(1)[0]!, [1, 0], "2026-11-10T09:00:00.000Z", { id: "fake-semantic", dimension: 16 });
    ds.recordSignals([launchpad({ id: "pumpportal:events:create:New00002", title: `${CREATE_TITLE_PREFIX}Zebra Dust ($ZD)`, publishedAt: "2026-11-10T10:00:00.000Z" })], NOW);
    await clusterNewSignals(ds, fakeEmbedder().embedder, { now: NOW });
    expect(narrativesOf(ds).map((g) => g.length)).toEqual([1, 1]);
  });

  it("migrates a database from before the ticket: old Narratives are news, the keys table is new, and opening again changes nothing", () => {
    const path = join(tempDir("argus-launchpad-"), "argus.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE narratives (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, summary TEXT NOT NULL, centroid TEXT NOT NULL,
      signal_count INTEGER NOT NULL, material_signal_count INTEGER NOT NULL, created_at TEXT NOT NULL, last_signal_at TEXT NOT NULL, changed_materially_at TEXT NOT NULL)`);
    old.prepare("INSERT INTO narratives (title, summary, centroid, signal_count, material_signal_count, created_at, last_signal_at, changed_materially_at) VALUES ('t', '', '[1,0]', 1, 1, 'x', 'y', 'z')").run();
    old.close();
    for (let i = 0; i < 2; i++) {
      const ds = Datastore.open(path);
      expect(ds.recentNarratives("a", { id: "hashing-v1", dimension: 256 }).map((n) => n.id)).toEqual([1]); // still a news Narrative, still joinable by embedding
      expect(ds.claimsForKey("anything")).toEqual([]);
      ds.close();
    }
  });
});
