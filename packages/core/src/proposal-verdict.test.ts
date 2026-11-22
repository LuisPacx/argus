import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore, type WarRoomStore } from "./datastore.ts";
import { DomainError, ProposalNotFoundError } from "./lifecycle.ts";
import { IDEA_SNAPSHOT_LIMITS, IDEA_VERDICT_TAGS, MAX_IDEA_NOTE_CHARS, ideaSnapshot, parseIdeaVerdictBody } from "./proposal-verdict.ts";
import { tempDir } from "./testing/temp.ts";
import type { MetaSnapshot, NewMemeTrio } from "./meme/types.ts";

/** War Room ticket 21: the Idea verdict. The store reads kind and Playbook version itself; the table is insert-only; nothing is stored on any refusal. */
const T0 = Date.parse("2026-11-22T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);
const HOUR = 3_600_000;

const snapshot: MetaSnapshot = {
  version: 1,
  capturedAt: at(0).toISOString(),
  meta: { key: "jensen", label: "Jensen", rank: 2, firstSeenAt: at(-5 * HOUR).toISOString(), counts: { "6h": { tokens: 1, creators: 1, migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens: 2, creators: 2, migrations: 0, migrationsAfter60s: 0 } }, topTokens: [] },
  run: { id: 1, computedAt: at(0).toISOString(), window: "24h", baseMigrationRate: 0.03, coverage: null },
  hot: { reason: "r", raisedAt: at(0).toISOString(), rank: 2, creators: 2 },
  roomLeft: { passed: true, text: "room" },
  tokens: [],
  news: [],
};
const trio = (playbookVersion?: string): NewMemeTrio => ({
  metaKey: "jensen",
  metaLabel: "Jensen",
  snapshot,
  reason: "r",
  summary: "s",
  evidenceLinks: [],
  ...(playbookVersion ? { playbookVersion } : {}),
  ideas: ["Alpha", "Bravo", "Charlie"].map((n, i) => ({ name: `Idea ${n}`, ticker: ["AAA", "BBB", "CCC"][i]!, angle: `Angle ${n}`, difference: "d", description: "p", hook: "gm", imageIdea: "i", riskLabels: [] })),
});
function seeded(playbookVersion?: string) {
  const store = Datastore.open(":memory:");
  const [a, b] = store.createMemeProposals(trio(playbookVersion), { now: at(0) });
  const tech = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: [] });
  return { store, a: a!, b: b!, tech };
}
const verdict = (over: Partial<Parameters<Datastore["addProposalVerdict"]>[0]> = {}) => ({ proposalId: 1, verdict: "good" as const, tags: [], note: "", ...over });
const count = (store: Datastore) => store.proposalVerdictsFor(1).length + store.proposalVerdictsFor(2).length + store.proposalVerdictsFor(4).length;

describe("addProposalVerdict: the War Room's insert", () => {
  it("stores kind and the Playbook version from the Proposal, and a snapshot of its name, ticker and angle", () => {
    const { store, a } = seeded("pb-7");
    const v = store.addProposalVerdict(verdict({ verdict: "bad", tags: ["boring", "name-taken"], note: "meh" }), { now: at(HOUR) });
    expect(v).toEqual({ id: 1, proposalId: a.id, verdict: "bad", tags: ["boring", "name-taken"], note: "meh", kind: "meme", playbookVersion: "pb-7", idea: { name: "Idea Alpha", ticker: "AAA", angle: "Angle Alpha" }, createdAt: at(HOUR).toISOString() });
  });

  it("a Proposal made with no Playbook stores null", () => {
    const { store } = seeded();
    expect(store.addProposalVerdict(verdict()).playbookVersion).toBeNull();
  });

  it("keeps history: a second verdict adds a row and is the current one (newest first)", () => {
    const { store, a, b } = seeded();
    store.addProposalVerdict(verdict({ verdict: "bad" }), { now: at(HOUR) });
    store.addProposalVerdict(verdict({ proposalId: b.id, verdict: "good" }), { now: at(HOUR) });
    const second = store.addProposalVerdict(verdict({ verdict: "good", tags: ["funny"], note: "grew on me" }), { now: at(2 * HOUR) });
    expect(store.proposalVerdictsFor(a.id).map((v) => [v.id, v.verdict])).toEqual([[3, "good"], [1, "bad"]]);
    expect(store.proposalVerdictsFor(a.id)[0]).toEqual(second);
    expect(store.currentProposalVerdicts()).toEqual({ [a.id]: "good", [b.id]: "good" });
  });

  it("the snapshot is the idea at verdict time, clamped; a later change of the Proposal does not change it", () => {
    const file = join(tempDir("argus-idea-clamp-"), "argus.db");
    const first = Datastore.open(file);
    first.createMemeProposals(trio(), { now: at(0) });
    first.close();
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE proposals SET name = ?, ticker = ?, why_now = ? WHERE id = 1").run("N".repeat(500), "T".repeat(500), "A".repeat(5000));
    raw.close();
    const store = Datastore.open(file);
    const v = store.addProposalVerdict(verdict());
    expect([...v.idea.name]).toHaveLength(IDEA_SNAPSHOT_LIMITS.name);
    expect([...v.idea.ticker]).toHaveLength(IDEA_SNAPSHOT_LIMITS.ticker);
    expect([...v.idea.angle]).toHaveLength(IDEA_SNAPSHOT_LIMITS.angle);
    expect(v.idea.angle.endsWith("…")).toBe(true);
    store.close();
    const later = new DatabaseSync(file);
    later.prepare("UPDATE proposals SET name = 'Renamed' WHERE id = 1").run();
    later.close();
    const reopened = Datastore.open(file);
    expect(reopened.proposalVerdictsFor(1)[0]!.idea.name).toBe(v.idea.name);
    reopened.close();
    expect(JSON.parse(ideaSnapshot({ name: "x", ticker: "y", angle: "z" }))).toEqual({ name: "x", ticker: "y", angle: "z" });
  });

  it("refuses an unknown Proposal and a Narrative-kind Proposal, and stores nothing", () => {
    const { store, tech } = seeded();
    expect(() => store.addProposalVerdict(verdict({ proposalId: 99 }))).toThrow(ProposalNotFoundError);
    expect(() => store.addProposalVerdict(verdict({ proposalId: tech.id }))).toThrow(DomainError);
    expect(count(store)).toBe(0);
    expect(store.currentProposalVerdicts()).toEqual({});
  });

  it("is on the War Room's allowed view, and nothing edits or deletes a verdict (type test)", () => {
    const { store } = seeded();
    const wr: WarRoomStore = store;
    expect(wr.addProposalVerdict).toBeDefined();
    expect(wr.proposalVerdictsFor).toBeDefined();
    expect(wr.currentProposalVerdicts).toBeDefined();
    // @ts-expect-error there is no edit
    expect(wr.updateProposalVerdict).toBeUndefined();
    // @ts-expect-error there is no delete
    expect(wr.deleteProposalVerdict).toBeUndefined();
  });

  it("the table has the documented columns and the (proposal_id, id) index, and a reopened database keeps the rows", () => {
    const file = join(tempDir("argus-idea-verdict-"), "argus.db");
    const first = Datastore.open(file);
    first.createMemeProposals(trio("pb-1"), { now: at(0) });
    first.addProposalVerdict(verdict(), { now: at(HOUR) });
    first.close();
    const raw = new DatabaseSync(file);
    expect((raw.prepare("PRAGMA table_info(proposal_verdicts)").all() as Array<{ name: string }>).map((c) => c.name)).toEqual(["id", "proposal_id", "verdict", "tags", "note", "kind", "playbook_version", "idea", "created_at"]);
    expect((raw.prepare("PRAGMA index_info(proposal_verdicts_proposal)").all() as Array<{ name: string }>).map((c) => c.name)).toEqual(["proposal_id", "id"]);
    raw.close();
    const reopened = Datastore.open(file);
    expect(reopened.proposalVerdictsFor(1)).toHaveLength(1);
    reopened.close();
  });
});

describe("parseIdeaVerdictBody", () => {
  it("names the allowlist and the limit the form shares", () => {
    expect(IDEA_VERDICT_TAGS).toEqual(["good-name", "funny", "great-hook", "fresh-angle", "timely", "name-taken", "too-generic", "wrong-angle", "boring", "risky"]);
    expect(MAX_IDEA_NOTE_CHARS).toBe(500);
  });

  it("a bare verdict is enough; the note is trimmed; a duplicate tag is kept once", () => {
    expect(parseIdeaVerdictBody({ verdict: "good" })).toEqual({ ok: true, value: { verdict: "good", tags: [], note: "" } });
    expect(parseIdeaVerdictBody({ verdict: "bad", tags: ["boring", "boring", "risky"], note: "  no  " })).toEqual({ ok: true, value: { verdict: "bad", tags: ["boring", "risky"], note: "no" } });
    expect(parseIdeaVerdictBody({ verdict: "good", note: "x".repeat(500) }).ok).toBe(true);
  });

  it("tolerates a playbookVersion or kind in the body without reading it", () => {
    expect(parseIdeaVerdictBody({ verdict: "good", playbookVersion: "evil", kind: "narrative" })).toEqual({ ok: true, value: { verdict: "good", tags: [], note: "" } });
  });

  it.each([
    ["an unknown verdict", { verdict: "great" }],
    ["no verdict", { tags: [] }],
    ["a verdict that is not text", { verdict: 1 }],
    ["an unknown tag", { verdict: "bad", tags: ["wrong-cluster"] }],
    ["tags that are not a list", { verdict: "bad", tags: "boring" }],
    ["a tag that is not text", { verdict: "bad", tags: [1] }],
    ["a note that is not text", { verdict: "bad", note: 5 }],
    ["a 501-character note", { verdict: "bad", note: "x".repeat(501) }],
    ["an extra key", { verdict: "bad", extra: true }],
    ["dimensions", { verdict: "bad", dimensions: [] }],
    ["an array", [{ verdict: "bad" }]],
    ["null", null],
    ["text", "{not json"],
    ["a number", 7],
  ])("refuses %s", (_name, body) => {
    expect(parseIdeaVerdictBody(body).ok).toBe(false);
  });

  it("says the 501-character limit by name", () => {
    expect(parseIdeaVerdictBody({ verdict: "bad", note: "x".repeat(501) })).toEqual({ ok: false, message: "The note is over 500 characters" });
  });
});
