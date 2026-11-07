import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Datastore, MAX_REVISE_INSTRUCTION_CHARS, type CommandType } from "@argus/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Endpoint-level tests: the real route handlers, called with the exact payloads the UI sends (index.vue and
 * proposals/[id].vue). Only Nitro's auto-imported globals are stubbed; the store is a real in-memory Datastore.
 */
type Ev = { params: Record<string, string>; body: unknown };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params[k]);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("getQuery", () => ({}));
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => "/argus/data");
vi.stubGlobal("useBuildRoot", () => "/builds/code");

type Handler = (e: Ev) => Promise<unknown>;
const commands = (await import("../api/proposals/[id]/commands.post.ts")).default as unknown as Handler;
const specPut = (await import("../api/proposals/[id]/spec.put.ts")).default as unknown as Handler;
const create = (await import("../api/proposals/index.post.ts")).default as unknown as Handler;
const one = (await import("../api/proposals/[id].get.ts")).default as unknown as (e: Ev) => Record<string, unknown>;
const list = (await import("../api/proposals/index.get.ts")).default as unknown as (e: Ev) => Array<{ id: number; resumeCommand: string | null }>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SPEC = "# Cat\n\n## Goal\n\ng\n\n## Scope\n\ns\n\n## Acceptance criteria\n\n- [ ] a\n";
const proposal = { narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: [] as string[] };

beforeEach(() => {
  store = Datastore.open(":memory:");
});

const specDirs: string[] = [];
afterEach(() => {
  for (const d of specDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(status: "new" | "shortlisted" | "spec-drafted") {
  const p = store.createProposal(proposal);
  if (status !== "new") store.transition(p.id, "shortlisted", "operator");
  if (status === "spec-drafted") {
    const dir = mkdtempSync(join(tmpdir(), "argus-route-"));
    specDirs.push(dir);
    const path = join(dir, "spec.md");
    writeFileSync(path, SPEC);
    store.completeSpec(p.id, { path, hash: sha(SPEC) });
  }
  return p.id;
}
const post = (id: number, body: unknown) => commands({ params: { id: String(id) }, body });
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ statusCode: 200 }), (e: { statusCode: number }) => e)) as { statusCode: number }).statusCode;

describe("POST /api/proposals/:id/commands, UI payloads", () => {
  const cases: Array<[string, CommandType, string, "new" | "shortlisted" | "spec-drafted"]> = [
    ["Shortlist button", "shortlist", "", "new"],
    ["Dismiss with a typed reason", "dismiss", "not interesting", "new"],
    ["Approve button", "approve", "", "spec-drafted"],
    ["Revise with an instruction", "revise", "Add more cats", "spec-drafted"],
    ["Retry Spec button (index.vue and proposals/[id].vue)", "retry-spec", "", "shortlisted"],
  ];
  for (const [name, type, reason, from] of cases) {
    it(`${name}: { type: "${type}", reason: ${JSON.stringify(reason)} } is accepted and queued`, async () => {
      const id = seed(from);
      const cmd = (await post(id, { type, reason })) as { type: string; reason: string };
      expect(cmd).toMatchObject({ type, reason });
      expect(store.pendingCommands().map((c) => c.type)).toEqual([type]);
    });
  }

  it("rejects dismiss and revise without a reason, but not retry-spec, shortlist or approve", async () => {
    const id = seed("spec-drafted");
    expect(await status(post(id, { type: "dismiss", reason: "  " }))).toBe(400);
    expect(await status(post(id, { type: "revise", reason: "" }))).toBe(400);
    expect(await status(post(id, { type: "retry-spec", reason: "" }))).toBe(200);
  });

  it("rejects an unknown type with 400 and a missing Proposal with 404", async () => {
    const id = seed("new");
    expect(await status(post(id, { type: "nope", reason: "" }))).toBe(400);
    expect(await status(post(999, { type: "shortlist", reason: "" }))).toBe(404);
  });

  it("caps the revise instruction at the worker's limit", async () => {
    const id = seed("spec-drafted");
    expect(await status(post(id, { type: "revise", reason: "x".repeat(MAX_REVISE_INSTRUCTION_CHARS) }))).toBe(200);
    expect(await status(post(id, { type: "revise", reason: "x".repeat(MAX_REVISE_INSTRUCTION_CHARS + 1) }))).toBe(400);
  });
});

const SESSION = "5e55a0a0-0000-4000-8000-000000000001";

/** A Proposal whose Build failed after its retry, as the runner leaves it. */
function seedBuildFailed(session: string | null = SESSION) {
  const id = seed("spec-drafted");
  store.transition(id, "approved", "operator");
  const run = store.beginBuild(id, { backend: "claude-code", model: "sonnet" });
  store.finishBrainRun(run, { sessionId: session, totalCostUsd: 1, exitStatus: "failed" });
  store.transition(id, "build-failed", "build", "Build failed: claude failed: x");
  return id;
}

describe("POST /api/proposals/:id/commands, the Re-queue button", () => {
  it('{ type: "requeue", reason: "" } is accepted and queued', async () => {
    const id = seedBuildFailed();
    expect(await post(id, { type: "requeue", reason: "" })).toMatchObject({ type: "requeue", reason: "" });
    expect(store.pendingCommands().map((c) => c.type)).toEqual(["requeue"]);
  });
});

describe("GET /api/proposals and /api/proposals/:id, the resume command on a build-failed card", () => {
  it("shows the exact claude --resume command, run from the Build repo with the per-Build home as claude's config", async () => {
    const id = seedBuildFailed();
    const expected = `cd /builds/code/${store.getProposal(id)!.slug} && CLAUDE_CONFIG_DIR=/argus/data/proposals/${id}/home/.claude claude --resume ${SESSION}`;
    expect(one({ params: { id: String(id) }, body: undefined })).toMatchObject({ status: "build-failed", buildSessionId: SESSION, resumeCommand: expected });
    expect(list({ params: {}, body: undefined }).find((p) => p.id === id)!.resumeCommand).toBe(expected);
  });

  it("has none for a Proposal that is not build-failed, or whose Build left no session", async () => {
    const failedWithout = seedBuildFailed(null);
    const spec = seed("spec-drafted");
    expect(one({ params: { id: String(failedWithout) }, body: undefined })).toMatchObject({ resumeCommand: null });
    expect(one({ params: { id: String(spec) }, body: undefined })).toMatchObject({ resumeCommand: null });
  });
});

describe("GET /api/proposals and /api/proposals/:id, the collision checks on the card", () => {
  const at = "2026-11-06T10:00:00.000Z";
  const collisions = {
    dex: { status: "collides" as const, detail: "ticker CAT is taken", source: "DexScreener", checkedAt: at },
    github: { status: "unknown" as const, detail: "timed out", source: "GitHub", checkedAt: at },
  };
  it("carry every result with its status, source and check time, an unknown staying unknown", () => {
    const nid = 1;
    store.recordSignals([{ id: "s:1", sourceId: "rss:a", sourceLabel: "Feed", title: "t", summary: "", url: "https://a.example/1", publishedAt: at }]);
    store.createNarrative(store.unclusteredSignals(5)[0]!, [1, 0], at, { id: "e", dimension: 2 });
    const sid = store.recordScore({ narrativeId: nid, rubricVersion: 1, scores: { buildability: 8 }, total: 8, rationale: "r", signalCount: 1, changedMateriallyAt: at, createdAt: at });
    const made = store.createResearchProposal({ ...proposal, evidenceLinks: ["https://e.example/1", "https://e.example/2", "https://e.example/3"], narrativeId: nid, scoreId: sid, collisions });
    expect(one({ params: { id: String(made.id) }, body: undefined })).toMatchObject({ collisions });
    expect(list({ params: {}, body: undefined }).find((p) => p.id === made.id)).toMatchObject({ collisions });
  });
  it("are null for a Proposal that was never checked, so the card says so instead of showing clear", () => {
    expect(one({ params: { id: String(seed("new")) }, body: undefined })).toMatchObject({ collisions: null });
  });
});

describe("PUT /api/proposals/:id/spec, UI payload { content, baseHash }", () => {
  it("saves and returns the new hash", async () => {
    const id = seed("spec-drafted");
    const res = (await specPut({ params: { id: String(id) }, body: { content: "# Edited\n", baseHash: sha(SPEC) } })) as { hash: string };
    expect(res.hash).toBe(sha("# Edited\n"));
  });
  it("409 on a stale hash, 400 on a missing field, 413 over the size cap", async () => {
    const id = seed("spec-drafted");
    expect(await status(specPut({ params: { id: String(id) }, body: { content: "x", baseHash: "stale" } }))).toBe(409);
    expect(await status(specPut({ params: { id: String(id) }, body: { content: "x" } }))).toBe(400);
    expect(await status(specPut({ params: { id: String(id) }, body: { content: "x".repeat(200 * 1024 + 1), baseHash: sha(SPEC) } }))).toBe(413);
  });
});

describe("POST /api/proposals, UI payload from the new-Proposal form", () => {
  it("creates a Proposal from the form fields with evidenceLinks split on newlines", async () => {
    const created = (await create({ params: {}, body: { ...proposal, evidenceLinks: ["https://example.com/a", ""] } })) as { name: string };
    expect(created.name).toBe("Cat");
  });
  it("400 when a field is blank", async () => {
    expect(await status(create({ params: {}, body: { ...proposal, name: " " } }))).toBe(400);
  });
});
