import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import type { MetaSnapshot, NewMemeTrio } from "../meme/types.ts";

/** Human researcher ticket 20: the "Is it learning?" counts, against a hand-built fixture. */
const T0 = Date.parse("2026-11-22T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);

const snapshot = (key: string): MetaSnapshot => ({
  version: 1,
  capturedAt: at(0).toISOString(),
  meta: { key, label: key, rank: 2, firstSeenAt: at(0).toISOString(), counts: { "6h": { tokens: 1, creators: 1, migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens: 2, creators: 2, migrations: 0, migrationsAfter60s: 0 } }, topTokens: [] },
  run: { id: 1, computedAt: at(0).toISOString(), window: "24h", baseMigrationRate: 0.03, coverage: null },
  hot: { reason: "r", raisedAt: at(0).toISOString(), rank: 2, creators: 2 },
  roomLeft: { passed: true, text: "room" },
  tokens: [],
  news: [],
});
const trio = (key: string, tickers: string[], playbookVersion?: string): NewMemeTrio => ({
  metaKey: key,
  metaLabel: key,
  snapshot: snapshot(key),
  reason: "r",
  summary: "s",
  evidenceLinks: [],
  // Grouped by the version whose idea lessons the prompt carried; the Pick-lessons field is a decoy that must not count.
  playbookVersion: "9",
  ...(playbookVersion ? { ideasPlaybookVersion: playbookVersion } : {}),
  ideas: tickers.map((t) => ({ name: `Idea ${t}`, ticker: t, angle: `Angle ${t}`, difference: "d", description: "p", hook: "gm", imageIdea: "i", riskLabels: [] })),
});

function fixture() {
  const store = Datastore.open(":memory:");
  for (const id of [1, 2]) {
    store["db"].prepare("INSERT INTO playbook_requests (status, detail, created_at, done_at, run_ids) VALUES ('done', '', ?, ?, '[]')").run(at(0).toISOString(), at(0).toISOString());
    store["db"].prepare("INSERT INTO playbook_versions (request_id, text, pick_ids, settle_cutoff, created_at) VALUES (?, 'lesson', '[]', ?, ?)").run(id, at(0).toISOString(), at(id).toISOString());
  }
  const v1 = store.createMemeProposals(trio("one", ["A1", "A2", "A3"], "1"), { now: at(0) });
  const v2 = store.createMemeProposals(trio("two", ["B1", "B2", "B3"], "2"), { now: at(0) });
  const none = store.createMemeProposals(trio("none", ["C1", "C2", "C3"]), { now: at(0) });
  store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: [] });
  const rate = (id: number, verdict: "good" | "bad", ms: number) => store.addProposalVerdict({ proposalId: id, verdict, tags: [], note: "" }, { now: at(ms) });
  rate(v1[0]!.id, "bad", 1);
  rate(v1[0]!.id, "good", 2); // newest verdict wins: good
  rate(v1[1]!.id, "bad", 3); // v1[2] stays unrated
  rate(v2[0]!.id, "good", 4); // v2: 1 rated of 3
  rate(none[0]!.id, "bad", 5);
  rate(none[1]!.id, "bad", 6);
  rate(none[2]!.id, "good", 7);
  return store;
}

describe("playbookState().learning", () => {
  it("counts made, rated (newest verdict per Proposal) and good per version, then the no-Playbook baseline; tech Proposals are not counted", () => {
    expect(fixture().playbookState().learning).toEqual([
      { version: "2", made: 3, rated: 1, good: 1 },
      { version: "1", made: 3, rated: 2, good: 1 },
      { version: null, made: 3, rated: 3, good: 1 },
    ]);
  });

  it("with no versions it is the baseline row alone, zeros included", () => {
    expect(Datastore.open(":memory:").playbookState().learning).toEqual([{ version: null, made: 0, rated: 0, good: 0 }]);
  });
});
