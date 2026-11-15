import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore, type NarrativeDetail, type StoredSignal } from "./datastore.ts";
import { judgePromptFor } from "./judge.ts";
import { LEGITIMACY_RULE, LEGITIMACY_RULE_MARKER, TECH_VALUE_LINE } from "./rubric.ts";
import { tempDir } from "./testing/temp.ts";

/** Missed ideas ticket 04: Rubric v3, legitimacy penalises impersonation and fraud only. */
const KEYS = ["momentum", "novelty", "buildability", "hook", "legitimacy"] as const;
const V2_LEGITIMACY = "Whether it is free of scams, hate and real-person impersonation, and backed by real sources.";
const OLD_HOOK = "How easily the idea is explained and shared in one line.";
const EMBEDDER = { id: "sem-test", dimension: 2 };
const NOW = "2026-11-14T12:00:00.000Z";

/** A database as the live one is: Rubric v1 and v2 (Tech-value line) with the old legitimacy text, one Narrative and a Score under v2. */
function liveShapedDb(): { path: string; narrativeId: number } {
  const path = join(tempDir("argus-rubric-v3-"), "argus.db");
  const seed = Datastore.open(path);
  seed.recordSignals([{ id: "s:1", sourceId: "pumpportal:events", sourceLabel: "Feed", title: "A story", summary: "s", url: "https://a.example/1", publishedAt: NOW }]);
  const narrativeId = seed.createNarrative(seed.unclusteredSignals(5)[0]!, [1, 0], NOW, EMBEDDER);
  seed.recordScore({ narrativeId, rubricVersion: 2, scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 1 }, total: 5.4, rationale: "old rule", signalCount: 1, changedMateriallyAt: NOW, createdAt: NOW });
  seed.close();
  const raw = new DatabaseSync(path);
  const dims = (hook: string) => JSON.stringify(KEYS.map((key) => ({ key, weight: 1, description: key === "legitimacy" ? V2_LEGITIMACY : key === "hook" ? hook : `${key} text` })));
  raw.exec("DELETE FROM rubric_versions");
  raw.prepare("INSERT INTO rubric_versions VALUES (1, ?, 5, '2026-06-01T00:00:00.000Z')").run(dims(OLD_HOOK));
  raw.prepare("INSERT INTO rubric_versions VALUES (2, ?, 5, '2026-06-02T00:00:00.000Z')").run(dims(`${OLD_HOOK} ${TECH_VALUE_LINE}`));
  raw.close();
  return { path, narrativeId };
}

const dump = (path: string, table: string): string => {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify(raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  } finally {
    raw.close();
  }
};

describe("Rubric v3 registration", () => {
  it("adds v3 on a v2 database: only legitimacy changes, v1 and v2 rows are byte for byte unchanged, the gate is kept", () => {
    const { path } = liveShapedDb();
    const before = dump(path, "rubric_versions");
    const ds = Datastore.open(path);
    expect(ds.listRubricVersions()).toEqual([3, 2, 1]);
    ds.close();
    const after = JSON.parse(dump(path, "rubric_versions")) as Array<{ version: number; dimensions: string; gate_min_score: number }>;
    expect(JSON.stringify(after.filter((r) => r.version <= 2))).toBe(before);
    const [v2, v3] = [after[1]!, after[2]!];
    expect(v3.gate_min_score).toBe(v2.gate_min_score);
    const d2 = JSON.parse(v2.dimensions) as Array<{ key: string; description: string; weight: number }>;
    const d3 = JSON.parse(v3.dimensions) as typeof d2;
    expect(d3.filter((d) => d.key !== "legitimacy")).toEqual(d2.filter((d) => d.key !== "legitimacy"));
    expect(d3.find((d) => d.key === "legitimacy")!.description).toBe(LEGITIMACY_RULE);
    expect(d2.find((d) => d.key === "legitimacy")!.description).toBe(V2_LEGITIMACY);
  });

  it("is idempotent: a second open adds nothing, and a fresh database starts with the rule", () => {
    const { path } = liveShapedDb();
    Datastore.open(path).close();
    const again = Datastore.open(path);
    expect(again.listRubricVersions()).toEqual([3, 2, 1]);
    again.close();
    expect(Datastore.open(":memory:").getRubric().dimensions.find((d) => d.key === "legitimacy")!.description).toBe(LEGITIMACY_RULE);
  });

  it("keeps the rule inside the Rubric editor's description limit", () => {
    expect(LEGITIMACY_RULE.length).toBeLessThanOrEqual(1000);
  });
});

describe("old Scores are history", () => {
  it("keeps Scores under v2 byte for byte and re-judges no Narrative because of the version alone", () => {
    const { path, narrativeId } = liveShapedDb();
    const before = dump(path, "scores");
    const ds = Datastore.open(path);
    expect(ds.getRubric().version).toBe(3);
    expect(ds.narrativesToJudge(EMBEDDER, "2026-01-01T00:00:00.000Z", 50).map((n) => n.id)).not.toContain(narrativeId);
    ds.close();
    expect(dump(path, "scores")).toBe(before);
    expect(JSON.parse(before)[0].rubric_version).toBe(2);
  });
});

const sig = (n: number, title: string, summary: string): StoredSignal => ({
  id: `s:${n}`, sourceId: "pumpportal:events", sourceLabel: "Feed", title, summary, url: `https://a.example/${n}`, publishedAt: NOW, ingestedAt: NOW,
});
const detail = (title: string, summary: string): NarrativeDetail => ({
  id: 1, title, summary: "", signalCount: 1, createdAt: NOW, lastSignalAt: NOW, changedMateriallyAt: NOW, signals: [sig(1, title, summary)],
}) as NarrativeDetail;

describe("the v3 judge prompt", () => {
  const v3 = Datastore.open(liveShapedDb().path).getRubric();
  const v2 = Datastore.open(liveShapedDb().path).getRubric(2);

  it("states the impersonation-and-fraud rule and the satire allowance, and no longer penalises allegations about a named person", () => {
    const prompt = judgePromptFor(v3, detail("A story", "s"));
    expect(prompt).toContain(LEGITIMACY_RULE_MARKER);
    for (const word of ["impersonation", "fraud", "fake giveaway", "claims to be official", "satire, parody or comedy about a public figure"]) expect(prompt).toContain(word);
    expect(prompt).not.toMatch(/unverified allegations/i);
    expect(prompt).not.toContain(V2_LEGITIMACY);
  });

  it("keeps v2 addressable: a replay under v2 builds the v2 text", () => {
    const prompt = judgePromptFor(v2, detail("A story", "s"));
    expect(prompt).toContain("Rubric version 2");
    expect(prompt).toContain(V2_LEGITIMACY);
    expect(prompt).not.toContain(LEGITIMACY_RULE_MARKER);
  });

  it("fixtures: a fake Brain that echoes the rule it was given sees the same penalty for impersonation and fraud and the allowance for satire", () => {
    const echo = (prompt: string): string => prompt.split("\n").find((l) => l.startsWith("- legitimacy"))!;
    const satire = detail("Jensen meme coin: the leather jacket CEO", "A joke token named after the CEO. Not affiliated, pure comedy.");
    const official = detail("The OFFICIAL Jensen coin", "The CEO's own token, endorsed by him. Buy now.");
    const giveaway = detail("Jensen giveaway: send 1 SOL, get 10 back", "Free airdrop for the first 100 senders.");
    for (const n of [satire, official, giveaway]) {
      const prompt = judgePromptFor(v3, n);
      const rule = echo(prompt);
      expect(rule).toContain("Score 0 to 2 for impersonation");
      expect(rule).toContain("a fake giveaway");
      expect(rule).toContain("Do not lower it for satire");
      expect(prompt).toContain(n.title);
    }
    // the Narrative that is only satire names no impersonation or fraud claim of its own, the other two do
    expect(judgePromptFor(v3, satire)).not.toMatch(/OFFICIAL|giveaway: send/);
    expect(judgePromptFor(v3, official)).toContain("OFFICIAL");
    expect(judgePromptFor(v3, giveaway)).toContain("send 1 SOL");
  });
});
