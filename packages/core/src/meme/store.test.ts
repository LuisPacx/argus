import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBrain, resolveRouting } from "../brain.ts";
import { Datastore, migrate, MemeTrioExistsError, MAX_NEW_PROPOSALS_PER_DAY, type Proposal } from "../datastore.ts";
import { expireStaleProposals, EXPIRY_MS, MEME_EXPIRY_MS } from "../expiry.ts";
import { applyCommand, MemeLifecycleError, MEME_NO_BUILD_MESSAGE } from "../lifecycle.ts";
import { draftPendingSpecs } from "../spec-drafting.ts";
import { FAKE_CLAUDE } from "../testing/fake-claude.ts";
import { applyPending } from "../testing/apply.ts";
import { tempDir } from "../testing/temp.ts";
import type { MetaSnapshot, NewMemeIdea, NewMemeTrio } from "./types.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-12T20:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);

const snapshot = (key = "jensen"): MetaSnapshot => ({
  version: 1,
  capturedAt: at(0).toISOString(),
  meta: { key, label: "Jensen", rank: 2, firstSeenAt: at(-5 * HOUR).toISOString(), counts: { "6h": { tokens: 100, creators: 70, migrations: 3, migrationsAfter60s: 1 }, "24h": { tokens: 256, creators: 141, migrations: 9, migrationsAfter60s: 4 } }, topTokens: [{ mint: "Mint1", name: "Jensen", symbol: "JENSEN" }] },
  run: { id: 7, computedAt: at(-10 * 60_000).toISOString(), window: "24h", baseMigrationRate: 0.03, coverage: null },
  hot: { reason: "creators 70 to 148 in 1 h", raisedAt: at(0).toISOString(), rank: 2, creators: 141 },
  roomLeft: { passed: true, text: "still has room" },
  tokens: [{ mint: "Mint1", name: "Jensen", symbol: "JENSEN", migrated: true }],
  news: [{ title: "Jensen resigns", sourceLabel: "Wired", url: "https://example.com/a", publishedAt: at(-2 * HOUR).toISOString() }],
});
const memeIdea = (n: number): NewMemeIdea => ({
  name: `Meme Idea ${["Alpha", "Bravo", "Charlie"][n]}`,
  ticker: ["AAA", "BBB", "CCC"][n]!,
  angle: "The joke and why now.",
  difference: "Not the leader.",
  description: "A pitch.",
  hook: "gm",
  imageIdea: "A chair.",
  riskLabels: ["real person"],
});
const trio = (key = "jensen"): NewMemeTrio => ({ metaKey: key, metaLabel: "Jensen", snapshot: snapshot(key), reason: "Hot now: creators 70 to 148 in 1 h", summary: "Meta Jensen: 141 creators", evidenceLinks: ["https://example.com/a"], ideas: [memeIdea(0), memeIdea(1), memeIdea(2)] });
const narrative = { narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat Coin", ticker: "CAT", description: "d", evidenceLinks: [] as string[] };

describe("snapshot versions", () => {
  it("a version 2 snapshot (a Meta, its leader and its trigger) round-trips next to a version 1 snapshot of the Hot now era, and both stay readable", () => {
    const store = Datastore.open(":memory:");
    const v2: MetaSnapshot = {
      version: 2,
      capturedAt: at(0).toISOString(),
      meta: { key: "jensen", label: "Jensen", enteredAt: at(-HOUR).toISOString(), holding: false, counts: { "6h": { tokens: 1, creators: 1, migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens: 20, creators: 14, migrations: 2, migrationsAfter60s: 1 } }, topTokens: [] },
      leader: { mint: "MintJ", name: "Jensen Huang", symbol: "JENSEN", marketCapUsd: 2_400_000 },
      trigger: { kind: "new-meta", reason: "$JENSEN at $2.4M, 14 creators in 24 h", at: at(0).toISOString() },
      run: { id: 9, computedAt: at(0).toISOString() },
      roomLeft: { passed: true, text: "still has room" },
      tokens: [],
      news: [],
    };
    const [made2] = store.createMemeProposals({ ...trio("jensen"), snapshot: v2, reason: "New Meta: $JENSEN at $2.4M, 14 creators in 24 h" }, { now: at(0) });
    const [made1] = store.createMemeProposals(trio("old"), { now: at(0) });
    expect(store.getProposal(made2!.id)!.metaSnapshot).toEqual(v2);
    expect(store.getProposal(made1!.id)!.metaSnapshot).toEqual(snapshot("old"));
    expect(store.getProposal(made1!.id)!.reason).toBe("Hot now: creators 70 to 148 in 1 h");
  });
});

describe("the kind column and the trio", () => {
  it("stores three meme Proposals in new, with no Narrative, Score or Tech, and the idea fields", () => {
    const store = Datastore.open(":memory:");
    const made = store.createMemeProposals(trio(), { now: at(0) });
    expect(made).toHaveLength(3);
    expect(made.map((p) => p.slug)).toEqual(["meme-idea-alpha", "meme-idea-bravo", "meme-idea-charlie"]);
    for (const p of made) {
      expect(p).toMatchObject({ kind: "meme", status: "new", narrativeId: null, scoreId: null, narrativeCreatedAt: null, metaKey: "jensen", metaLabel: "Jensen", techOneLiner: "", interaction: "", whyNow: "The joke and why now.", reason: "Hot now: creators 70 to 148 in 1 h", narrativeSummary: "Meta Jensen: 141 creators" });
      expect(p.meme).toEqual({ difference: "Not the leader.", hook: "gm", imageIdea: "A chair.", riskLabels: ["real person"] });
      expect(p.metaSnapshot).toEqual(snapshot());
      expect(p.evidenceLinks).toEqual(["https://example.com/a"]);
    }
    expect(store.historyFor(made[0]!.id)[0]).toMatchObject({ from: null, to: "new", actor: "system" });
    expect(store.historyFor(made[0]!.id)[0]!.reason).toMatch(/Idea 1 of 3 for the Meta "Jensen"/);
  });

  it("is not a research Proposal: the 30 a day cap and the pipeline's proposal count do not see it", () => {
    const store = Datastore.open(":memory:");
    store.createMemeProposals(trio(), { now: at(0) });
    expect(store.researchProposalsSince(at(-24 * HOUR).toISOString())).toBe(0);
    expect(MAX_NEW_PROPOSALS_PER_DAY).toBe(30);
    const live = store.pipelineLive(at(HOUR), 5);
    expect(live.counts.proposals_created).toBe(0);
    expect(live.counts.memes_created).toBe(3);
  });

  it("refuses a trio of any other size", () => {
    const store = Datastore.open(":memory:");
    expect(() => store.createMemeProposals({ ...trio(), ideas: [memeIdea(0), memeIdea(1)] }, { now: at(0) })).toThrow(/3 ideas/);
    expect(store.listProposals()).toHaveLength(0);
  });

  it("refuses a second trio for the same Meta inside 6 h, whatever became of the first, and allows one after", () => {
    const store = Datastore.open(":memory:");
    const first = store.createMemeProposals(trio(), { now: at(0) });
    expect(() => store.createMemeProposals(trio(), { now: at(HOUR) })).toThrow(MemeTrioExistsError);
    for (const p of first) store.transition(p.id, "dismissed", "operator", "not now"); // dismissed: still inside the 6 h
    expect(() => store.createMemeProposals(trio(), { now: at(5 * HOUR) })).toThrow(MemeTrioExistsError);
    expect(store.listProposals()).toHaveLength(3); // the refused trio left nothing behind
    expect(store.createMemeProposals(trio(), { now: at(6 * HOUR + 60_000) })).toHaveLength(3);
    expect(store.createMemeProposals(trio("other"), { now: at(6 * HOUR + 120_000) })).toHaveLength(3); // another Meta is independent
  });

  it("the database itself holds one live trio per Meta per 6 h window (the partial unique index)", () => {
    const dir = tempDir("argus-meme-index-");
    const file = join(dir, "argus.db");
    const store = Datastore.open(file);
    const made = store.createMemeProposals(trio(), { now: at(0) });
    store.close();
    const db = new DatabaseSync(file);
    const insert = (slot: number, status: string) =>
      db.prepare("INSERT INTO proposals (slug, status, kind, meta_key, meme_window, meme_slot, created_at, updated_at) VALUES (?, ?, 'meme', 'jensen', ?, ?, ?, ?)").run(`dup-${slot}-${status}`, status, Math.floor(T0 / (6 * HOUR)), slot, at(0).toISOString(), at(0).toISOString());
    expect(() => insert(1, "new")).toThrow(/UNIQUE/);
    expect(() => insert(1, "shortlisted")).toThrow(/UNIQUE/);
    expect(() => insert(1, "dismissed")).not.toThrow(); // a dismissed or closed idea no longer holds its place
    expect(() => insert(2, "closed")).not.toThrow();
    expect(made).toHaveLength(3);
    db.close();
  });

  it("stores the Meta snapshot once: the database refuses to change it", () => {
    const dir = tempDir("argus-meme-snap-");
    const file = join(dir, "argus.db");
    const store = Datastore.open(file);
    const [p] = store.createMemeProposals(trio(), { now: at(0) });
    store.close();
    const db = new DatabaseSync(file);
    expect(() => db.prepare("UPDATE proposals SET meta_snapshot = ? WHERE id = ?").run("{}", p!.id)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE proposals SET meta_snapshot = NULL WHERE id = ?").run(p!.id)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE proposals SET status = 'shortlisted', updated_at = ? WHERE id = ?").run(at(1).toISOString(), p!.id)).not.toThrow(); // every other column can change
    expect(() => db.prepare("UPDATE proposals SET meta_snapshot = meta_snapshot WHERE id = ?").run(p!.id)).not.toThrow(); // a write of the same value changes nothing
    db.close();
    const reopened = Datastore.open(file);
    expect(reopened.getProposal(p!.id)!.metaSnapshot).toEqual(snapshot());
    reopened.close();
  });
});

describe("the migration is additive and idempotent, and old Proposals read narrative", () => {
  it("an old database (a proposals table from before the kind) gains the columns once, keeps its rows as narrative, and a second migrate changes nothing", () => {
    const dir = tempDir("argus-meme-migrate-");
    const file = join(dir, "old.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    old.prepare("INSERT INTO proposals (slug, status, created_at, updated_at) VALUES ('old-one', 'shortlisted', ?, ?)").run(at(-100 * HOUR).toISOString(), at(-100 * HOUR).toISOString());
    old.exec("CREATE TABLE status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL)");
    old.close();
    const store = Datastore.open(file);
    const p = store.getProposal(1)!;
    expect(p).toMatchObject({ kind: "narrative", metaKey: null, metaLabel: null, metaSnapshot: null, meme: null, status: "shortlisted" });
    expect(p.expiresAt).not.toBeNull(); // the 7 days of a Narrative Proposal
    store.close();
    const db = new DatabaseSync(file);
    const columns = () => (db.prepare("PRAGMA table_info(proposals)").all() as Array<{ name: string }>).map((c) => c.name).sort();
    const before = columns();
    for (const c of ["kind", "meta_key", "meta_label", "meta_snapshot", "meme_slot", "meme_window", "meme_difference", "meme_hook", "meme_image_idea", "meme_risk_labels"]) expect(before).toContain(c);
    const schema = () => JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all());
    const sql = schema();
    migrate(db);
    migrate(db);
    expect(columns()).toEqual(before);
    expect(schema()).toBe(sql);
    expect(db.prepare("SELECT kind FROM proposals WHERE id = 1").get()).toEqual({ kind: "narrative" });
    db.close();
  });
});

describe("the lifecycle of a meme Proposal", () => {
  const meme = (store: Datastore, now = at(0)): Proposal => store.createMemeProposals(trio(), { now })[0]!;

  it("Shortlist, Undo, Dismiss with a reason work through the real command path, and Why is its stored reason", () => {
    const store = Datastore.open(":memory:");
    const p = meme(store);
    const c1 = store.enqueueCommand(p.id, "shortlist");
    applyPending(store);
    expect(store.getCommand(c1.id)!.status).toBe("applied");
    expect(store.getProposal(p.id)!.status).toBe("shortlisted");
    const c2 = store.enqueueCommand(p.id, "undo-shortlist");
    applyPending(store);
    expect(store.getCommand(c2.id)!.status).toBe("applied");
    expect(store.getProposal(p.id)).toMatchObject({ status: "new", specPath: null, specError: "" });
    const noReason = store.enqueueCommand(p.id, "dismiss", "  ");
    applyPending(store);
    expect(store.getCommand(noReason.id)).toMatchObject({ status: "rejected", error: "Dismissal requires a reason" });
    const c3 = store.enqueueCommand(p.id, "dismiss", "a bad joke");
    applyPending(store);
    expect(store.getCommand(c3.id)!.status).toBe("applied");
    expect(store.getProposal(p.id)!.status).toBe("dismissed");
    expect(store.historyFor(p.id).at(-1)).toMatchObject({ from: "new", to: "dismissed", actor: "operator", reason: "a bad joke" });
    expect(store.getProposal(p.id)!.reason).toBe("Hot now: creators 70 to 148 in 1 h"); // what the card's Why reads
  });

  it.each(["approve", "revise", "retry-spec", "requeue", "mark-launched"] as const)("refuses the %s command with a clear message", (type) => {
    const store = Datastore.open(":memory:");
    const p = meme(store);
    store.transition(p.id, "shortlisted", "operator");
    const c = store.enqueueCommand(p.id, type, type === "revise" ? "make it funnier" : type === "mark-launched" ? "So11111111111111111111111111111111111111112" : "");
    applyPending(store);
    expect(store.getCommand(c.id)).toMatchObject({ status: "rejected", error: MEME_NO_BUILD_MESSAGE });
    expect(store.getProposal(p.id)!.status).toBe("shortlisted");
  });

  it("refuses a clean-up command too (it is applied by the worker's own pass, which calls applyCommand's refusal first)", () => {
    const store = Datastore.open(":memory:");
    const p = meme(store);
    const c = store.enqueueCommand(p.id, "cleanup-build");
    expect(() => applyCommand(store, c, { buildRoot: tempDir("argus-meme-clean-") } as never)).toThrow(MemeLifecycleError);
  });

  it("the transition itself refuses spec-drafted, approved, building, built and launched for a meme, even from the system", () => {
    const store = Datastore.open(":memory:");
    const p = meme(store);
    store.transition(p.id, "shortlisted", "operator");
    expect(() => store.transition(p.id, "spec-drafted", "system")).toThrow(MemeLifecycleError);
    expect(() => store.completeSpec(p.id, { path: "/x", hash: "h" })).toThrow(MemeLifecycleError);
    expect(store.getProposal(p.id)).toMatchObject({ status: "shortlisted", specPath: null });
    // The same transition is legal for a narrative Proposal.
    const n = store.createProposal(narrative);
    store.transition(n.id, "shortlisted", "operator");
    expect(() => store.transition(n.id, "spec-drafted", "system")).not.toThrow();
  });

  it("shortlisting a meme starts no Spec run: the drafting pass skips it and never calls the Brain", async () => {
    const store = Datastore.open(":memory:");
    const p = meme(store);
    store.transition(p.id, "shortlisted", "operator");
    const brain = new ClaudeCodeBrain({ routing: resolveRouting(), command: FAKE_CLAUDE, env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: "success", FAKE_CLAUDE_RESULT: "# Spec" }, passEnv: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_RESULT"] });
    expect(await draftPendingSpecs(store, brain, tempDir("argus-meme-spec-"), () => {})).toBe(0);
    expect(store.brainRunsFor(p.id)).toEqual([]);
    expect(store.getProposal(p.id)!.status).toBe("shortlisted");
  });

  it("a meme in new expires after 12 h counted from creation (one made 11 h ago is live, one made 13 h ago is not) while a narrative Proposal keeps 48 h", () => {
    const store = Datastore.open(":memory:");
    const m = meme(store);
    const n = store.createProposal(narrative);
    expect(MEME_EXPIRY_MS.new).toBe(12 * HOUR);
    expect(EXPIRY_MS.new).toBe(48 * HOUR);
    const created = Date.parse(m.createdAt);
    expect(m.expiresAt).toBe(new Date(created + 12 * HOUR).toISOString());
    expect(store.getProposal(n.id)!.expiresAt).toBe(new Date(Date.parse(n.createdAt) + 48 * HOUR).toISOString());
    expect(expireStaleProposals(store, new Date(created + 11 * HOUR))).toBe(0); // 11 h in: still live
    expect(expireStaleProposals(store, new Date(created + 12 * HOUR - 60_000))).toBe(0);
    expect(expireStaleProposals(store, new Date(created + 13 * HOUR))).toBe(3); // 13 h in: the three ideas of the trio are closed
    expect(store.getProposal(m.id)!.status).toBe("closed");
    expect(store.historyFor(m.id).at(-1)).toMatchObject({ from: "new", to: "closed", actor: "system", reason: "stale" });
    expect(store.getProposal(n.id)!.status).toBe("new"); // 13 h in, the narrative Proposal is untouched
    expect(expireStaleProposals(store, new Date(Date.parse(n.createdAt) + 48 * HOUR))).toBe(1);
  });

  it("a shortlisted meme keeps the 7 days; an undone shortlist does not restart the 12 h", () => {
    const store = Datastore.open(":memory:");
    const p = meme(store);
    store.transition(p.id, "shortlisted", "operator");
    const since = Date.parse(store.getProposal(p.id)!.updatedAt);
    expect(store.getProposal(p.id)!.expiresAt).toBe(new Date(since + 7 * 24 * HOUR).toISOString());
    expireStaleProposals(store, new Date(since + 7 * 24 * HOUR - 60_000)); // closes the trio's two ideas still in new (12 h), not this one (7 d)
    expect(store.getProposal(p.id)!.status).toBe("shortlisted");
    store.transition(p.id, "new", "operator");
    expect(store.getProposal(p.id)!.expiresAt).toBe(new Date(Date.parse(p.createdAt) + 12 * HOUR).toISOString());
  });
});

describe("lists, sorting and counts", () => {
  it("the Score sort puts meme Proposals after the scored ones, newest first; the kind filter selects them", () => {
    const store = Datastore.open(":memory:");
    const n1 = store.createProposal(narrative);
    const n2 = store.createProposal({ ...narrative, name: "Dog Coin" });
    const m1 = store.createMemeProposals(trio("one"), { now: at(0) });
    const m2 = store.createMemeProposals(trio("two"), { now: at(HOUR) });
    const order = (q: Parameters<Datastore["queryProposals"]>[0]) => store.queryProposals(q).map((p) => p.id);
    // No narrative Proposal here has a Score, so every one sorts as unscored, newest first (by id); a meme is never ahead of a scored one.
    expect(order({ sort: "score", kind: "meme" })).toEqual([...m2, ...m1].sort((a, b) => b.id - a.id).map((p) => p.id));
    expect(order({ kind: "narrative", sort: "newest" })).toEqual([n2.id, n1.id]);
    expect(order({ kind: "meme", status: "new" })).toHaveLength(6);
    expect(order({ kind: "meme", status: "shortlisted" })).toEqual([]);
    expect(order({})).toHaveLength(8);
  });

  it("a Narrative Proposal with a Score comes before every meme in the Score sort", () => {
    const store = Datastore.open(":memory:");
    const narrativeId = store.createNarrative({ id: "s1", sourceId: "x", sourceLabel: "x", title: "A story", summary: "", url: "https://example.com", publishedAt: at(0).toISOString(), ingestedAt: at(0).toISOString() }, [], at(0).toISOString(), { id: "e", dimension: 0 });
    const scoreId = store.recordScore({ narrativeId, rubricVersion: 1, scores: { momentum: 5, novelty: 5, buildability: 8, hook: 5, legitimacy: 5 }, total: 5.6, rationale: "r", signalCount: 1, changedMateriallyAt: at(0).toISOString(), createdAt: at(0).toISOString() });
    const scored = store.createResearchProposal({ ...narrative, narrativeId, scoreId }, { now: at(-HOUR) });
    const memes = store.createMemeProposals(trio(), { now: at(0) });
    const unscored = store.createProposal({ ...narrative, name: "Hand Entered" });
    const ids = store.queryProposals({ sort: "score" }).map((p) => p.id);
    expect(ids[0]).toBe(scored.id);
    expect(ids.slice(1)).toEqual([unscored.id, ...memes.map((p) => p.id).reverse()].sort((a, b) => b - a));
  });

  it("the live meme list is new and shortlisted only, newest first; the research spend and the recent runs include the meme task", () => {
    const store = Datastore.open(":memory:");
    const a = store.createMemeProposals(trio("one"), { now: at(0) });
    const b = store.createMemeProposals(trio("two"), { now: at(HOUR) });
    store.transition(a[0]!.id, "dismissed", "operator", "no");
    store.transition(a[1]!.id, "shortlisted", "operator");
    store.transition(a[2]!.id, "closed", "system");
    expect(store.liveMemeProposals().map((p) => p.id)).toEqual([...b.map((p) => p.id), a[1]!.id]);
    const id = store.startBrainRun({ proposalId: 0, task: "meme-ideas", backend: "claude-code", model: "sonnet" }, at(HOUR));
    store.finishBrainRun(id, { sessionId: null, totalCostUsd: 0.09, exitStatus: "success" });
    expect(store.researchSpendSince(at(0).toISOString())).toMatchObject({ runs: 1, costUsd: 0.09 });
    expect(store.memeIdeasSpendSince(at(0).toISOString()).runs).toBe(1);
    expect(store.recentBrainRuns(5)).toHaveLength(1);
  });

  it("Telegram never announces a meme Proposal, a narrative one still is", () => {
    const store = Datastore.open(":memory:");
    store.createMemeProposals(trio(), { now: at(0) });
    const n = store.createProposal(narrative);
    expect(store.unannouncedNewProposals().map((p) => p.id)).toEqual([n.id].filter(() => false).concat(store.unannouncedNewProposals().map((p) => p.id)));
    expect(store.unannouncedNewProposals().every((p) => p.kind === "narrative")).toBe(true);
  });
});

describe("recentTechs (proposal-routing ticket 02)", () => {
  const DAY = 24 * HOUR;
  const made = (store: Datastore, n: number, tech: string, when: number) => store.createResearchProposal({ ...narrative, techOneLiner: tech, narrativeId: n, scoreId: n }, { now: at(when) });

  it("lists Techs newest first, flattened, deduplicated, with the 14 day edge counted from creation and a meme Proposal skipped", () => {
    const dir = tempDir("argus-techs-");
    const file = join(dir, "argus.db");
    const store = Datastore.open(file);
    made(store, 1, "too old", -14 * DAY - 1);
    const edge = made(store, 2, "on the edge", -14 * DAY);
    made(store, 3, "a game\nof  cats", -3 * DAY);
    made(store, 4, "a game of cats", -2 * DAY); // the same line once flattened
    made(store, 5, "newest", -HOUR);
    store.createMemeProposals(trio(), { now: at(-30 * 60_000) });
    store.close();
    const db = new DatabaseSync(file);
    db.prepare("UPDATE proposals SET updated_at = ? WHERE id = ?").run(at(0).toISOString(), edge.id); // a later change keeps nothing "recent"
    db.close();
    const reopened = Datastore.open(file);
    expect(reopened.recentTechs(at(0))).toEqual(["newest", "a game of cats", "on the edge"]);
    expect(reopened.recentTechs(at(DAY))).toEqual(["newest", "a game of cats"]); // a day later the edge Proposal has aged out
    reopened.close();
  });

  it("returns at most 20", () => {
    const store = Datastore.open(":memory:");
    for (let i = 1; i <= 25; i++) made(store, i, `tech ${i}`, -i * 6 * HOUR);
    const techs = store.recentTechs(at(0));
    expect(techs).toHaveLength(20);
    expect(techs[0]).toBe("tech 1");
    expect(techs[19]).toBe("tech 20");
  });
});
