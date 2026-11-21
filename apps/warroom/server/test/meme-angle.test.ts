import { Datastore, META_RULE, type CurrentMeta, type NewMetaRun } from "@argus/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST and GET /api/meme-angle (meta redesign ticket 11), the real route handlers over a seeded in-memory store, called with the exact body
 * the form on /meta sends ({ metaKey, angle }). Only Nitro's auto-imported globals are stubbed. The War Room writes the request row and nothing
 * else: no Proposal and no status of any Proposal.
 */
type Ev = { body: unknown };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);

type Post = (e: Ev) => Promise<{ id: number; status: string; sourceUrl: string | null; urlDropped: boolean }>;
const post = (await import("../api/meme-angle.post.ts")).default as unknown as Post;
const list = (await import("../api/meme-angle.get.ts")).default as unknown as () => Array<Record<string, unknown>>;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const counts = (tokens: number, creators: number) => ({ "6h": { tokens, creators, migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens, creators, migrations: 0, migrationsAfter60s: 0 } });
const subject = (key: string, label: string): CurrentMeta => ({
  key,
  label,
  leader: { mint: `${key}Mint1111111111111111111111111111111111`.slice(0, 40), name: label, symbol: key.toUpperCase(), marketCapUsd: 2_000_000, source: "trending", stale: false, freshAt: ago(10) },
  holding: false,
  enteredAt: ago(180),
  counts: counts(40, 30),
  topTokens: [],
});
const saveRun = (metas: CurrentMeta[], watching: CurrentMeta[]) => {
  const run: NewMetaRun = { computedAt: ago(5), note: "n", rule: META_RULE, dexCalls: 0, dexFailures: 0, base: { "6h": { tokens: 1, migrations: 0 }, "24h": { tokens: 1, migrations: 0 } }, rows: { "6h": [], "24h": [] }, current: { metas, watching } };
  store.meta.saveRun(run);
};

const body = (over: Record<string, unknown> = {}) => ({ metaKey: "gta", angle: "GTA 6 iguana: official screenshot https://www.rockstargames.com/VI/only-in-leonida shows an iguana walking in front of a mobility scooter", ...over });
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ statusCode: 200 }), (e: { statusCode: number }) => e)) as { statusCode: number }).statusCode;
const message = async (p: Promise<unknown>) => ((await p.then(() => ({ statusMessage: "" }), (e: { statusMessage: string }) => e)) as { statusMessage: string }).statusMessage;
const stored = () => store.memeAngleRequests();
const noProposals = () => {
  expect(store.listProposals()).toEqual([]);
  expect(store.pendingCommands()).toEqual([]);
};
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.ARGUS_MEME_ANGLE_MAX_PER_DAY;
  delete process.env.ARGUS_MEME_ANGLE_MAX_PER_DAY;
  store = Datastore.open(":memory:");
  saveRun([subject("gta", "GTA 6"), subject("jensen", "Jensen")], [subject("watch", "Watch me")]);
});
afterEach(() => {
  if (saved === undefined) delete process.env.ARGUS_MEME_ANGLE_MAX_PER_DAY;
  else process.env.ARGUS_MEME_ANGLE_MAX_PER_DAY = saved;
});

describe("POST /api/meme-angle", () => {
  it("a good body returns the new request pending, with the link split out, and the row is pending", async () => {
    const r = await post({ body: body() });
    expect(r).toEqual({ id: 1, status: "pending", sourceUrl: "https://www.rockstargames.com/VI/only-in-leonida", urlDropped: false });
    expect(stored()).toEqual([{ id: 1, metaKey: "gta", status: "pending", detail: "", createdAt: expect.any(String), doneAt: null, proposalIds: [], urlDropped: false }]);
    expect(store.getAngleRequest(1)).toMatchObject({ metaLabel: "GTA 6", angle: "GTA 6 iguana: official screenshot www.rockstargames.com shows an iguana walking in front of a mobility scooter" });
    noProposals();
  });

  it("the Make ideas button (no angle key) writes one pending request with no text, and nothing else (human researcher ticket 02)", async () => {
    const r = await post({ body: { metaKey: "gta" } });
    expect(r).toEqual({ id: 1, status: "pending", sourceUrl: null, urlDropped: false });
    expect(store.getAngleRequest(1)).toMatchObject({ metaKey: "gta", metaLabel: "GTA 6", angle: "", status: "pending" });
    noProposals();
  });

  it("Make ideas on a Meta that is not current is a 400 with the reason, and a second press while one waits is a 429", async () => {
    const gone = post({ body: { metaKey: "no-such-meta" } });
    expect(await message(gone)).toMatch(/not a current Meta/);
    expect(await status(post({ body: { metaKey: "no-such-meta" } }))).toBe(400);
    expect(stored()).toEqual([]);
    await post({ body: { metaKey: "gta" } });
    expect(await message(post({ body: { metaKey: "gta" } }))).toMatch(/One request is waiting/);
    expect(await status(post({ body: { metaKey: "gta" } }))).toBe(429);
    expect(stored()).toHaveLength(1);
  });

  it("Make ideas can be pressed again for the same Meta once the first is done (no duplicate rule for an empty angle), and the allowance applies", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await post({ body: { metaKey: "gta" } });
      store.resolveAngleRequest(r.id, { status: "done", detail: "3 ideas" });
    }
    expect(await message(post({ body: { metaKey: "gta" } }))).toMatch(/10 angle requests in 24 hours is the most/);
    expect(await status(post({ body: { metaKey: "gta" } }))).toBe(429);
    expect(stored()).toHaveLength(10);
  });

  it("a Watching subject is accepted too", async () => {
    expect(await post({ body: body({ metaKey: "watch" }) })).toMatchObject({ status: "pending" });
  });

  it.each([
    ["a body that is not an object", "just text"],
    ["an array", [{ metaKey: "gta", angle: "x" }]],
    ["null", null],
    ["a number", 7],
    ["a metaKey that is not text", body({ metaKey: 7 })],
    ["an empty metaKey", body({ metaKey: "" })],
    ["an angle that is not text", body({ angle: { text: "x" } })],
    ["a null angle", body({ angle: null })],
    ["an empty angle", body({ angle: "" })],
    ["a whitespace angle", body({ angle: " \n\t " })],
    ["601 characters", body({ angle: "x".repeat(601) })],
    ["100,000 characters", body({ angle: "y".repeat(100_000) })],
    ["an unknown Meta key", body({ metaKey: "no-such-meta" })],
    ["an extra key", body({ sourceUrl: "https://example.com" })],
    ["an extra key that tries to set the status", body({ status: "done" })],
    ["a body over the size limit", body({ pad: "z".repeat(50_000) })],
  ])("%s is a 400 and stores nothing", async (_name, b) => {
    expect(await status(post({ body: b }))).toBe(400);
    expect(stored()).toEqual([]);
    noProposals();
  });

  it("exactly 600 characters is accepted", async () => {
    expect(await status(post({ body: body({ angle: "x".repeat(600) }) }))).toBe(200);
  });

  it("the 11th request of the day is a 429 with the reason in words, and stores nothing", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await post({ body: body({ angle: `angle number ${i}` }) });
      store.resolveAngleRequest(r.id, { status: "done", detail: "3 ideas" });
    }
    const p = post({ body: body({ angle: "angle number 10" }) });
    expect(await message(p)).toMatch(/10 angle requests in 24 hours is the most \(10\)/);
    expect(await status(post({ body: body({ angle: "angle number 10" }) }))).toBe(429);
    expect(stored()).toHaveLength(10);
  });

  it("refused requests do not spend the day's 10 (ticket 16)", async () => {
    for (let i = 0; i < 6; i++) {
      const r = await post({ body: body({ angle: `refused angle ${i}` }) });
      store.resolveAngleRequest(r.id, { status: "refused", detail: "a name copies a live token DexScreener lists" });
    }
    expect(await status(post({ body: body({ angle: "the seventh" }) }))).toBe(200);
  });

  it("ARGUS_MEME_ANGLE_MAX_PER_DAY can lower the cap", async () => {
    process.env.ARGUS_MEME_ANGLE_MAX_PER_DAY = "1";
    const r = await post({ body: body() });
    store.resolveAngleRequest(r.id, { status: "done", detail: "" });
    expect(await status(post({ body: body({ angle: "second" }) }))).toBe(429);
  });

  it("a second request while one waits is a 429 that says so", async () => {
    await post({ body: body() });
    const p = post({ body: body({ metaKey: "jensen", angle: "another" }) });
    expect(await message(p)).toMatch(/One request is waiting/);
    expect(await status(post({ body: body({ metaKey: "jensen", angle: "another" }) }))).toBe(429);
    expect(stored()).toHaveLength(1);
  });

  it("the same cleaned angle for the same Meta within 24 h is a 409; a different Meta or a different angle is accepted", async () => {
    const first = await post({ body: body({ angle: "Iguana\n  scooter" }) });
    store.resolveAngleRequest(first.id, { status: "done", detail: "" });
    expect(await status(post({ body: body({ angle: "iguana scooter" }) }))).toBe(409);
    expect(stored()).toHaveLength(1);
    const other = await post({ body: body({ metaKey: "jensen", angle: "iguana scooter" }) });
    store.resolveAngleRequest(other.id, { status: "done", detail: "" });
    expect(await status(post({ body: body({ angle: "iguana scooter, again but different" }) }))).toBe(200);
  });

  it("a javascript: address in the angle is text, never a stored link", async () => {
    const r = await post({ body: body({ angle: "see javascript:alert(1) and data:text/html,<b>x</b>" }) });
    expect(r.sourceUrl).toBeNull();
    expect(store.getAngleRequest(r.id)).toMatchObject({ sourceUrl: null, angle: "see javascript:alert(1) and data:text/html,<b>x</b>" });
  });

  it("a link with credentials is dropped, and the response says so", async () => {
    const r = await post({ body: body({ angle: "see https://user:secret@example.com/path now" }) });
    expect(r).toMatchObject({ sourceUrl: null, urlDropped: true });
    expect(store.getAngleRequest(r.id)).toMatchObject({ sourceUrl: null, urlDropped: true, angle: "see example.com now" });
  });

  it("html and newlines in the angle are stored as one line of plain text", async () => {
    const r = await post({ body: body({ angle: "<img src=x onerror=1>\nline two\r\nline three" }) });
    expect(store.getAngleRequest(r.id)!.angle).toBe("<img src=x onerror=1> line two line three");
  });
});

describe("GET /api/meme-angle", () => {
  it("lists at most 20 requests, newest first, with the status and the Proposal ids and no other column", async () => {
    for (let i = 0; i < 22; i++) {
      const at = new Date(Date.now() - (30 - i) * 25 * 3_600_000); // 25 h apart: no daily cap in the way
      const r = store.requestMemeAngle({ metaKey: "gta", angle: `angle ${i}`, sourceUrl: "https://example.com/secret-link" }, { now: at });
      store.resolveAngleRequest(r.id, { status: "done", detail: "3 ideas", proposalIds: [i * 3 + 1, i * 3 + 2, i * 3 + 3] });
    }
    const rows = list();
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ id: 22, status: "done", proposalIds: [64, 65, 66] });
    expect(rows[19]!.id).toBe(3);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["createdAt", "detail", "doneAt", "id", "metaKey", "proposalIds", "status", "urlDropped"]);
    expect(JSON.stringify(rows)).not.toContain("secret-link");
    expect(JSON.stringify(rows)).not.toContain("angle 5");
  });

  it("is empty before the first request", () => {
    expect(list()).toEqual([]);
  });
});
