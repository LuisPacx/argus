import { Datastore } from "@argus/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
// The worker's apply step, as in the core tests: after the datastore import.
import { applyPending } from "../../../../packages/core/src/testing/apply.ts";

/** Endpoint-level tests for the Launch handoff: the real handlers with the exact payloads proposals/[id].vue sends. */
type Ev = { params: Record<string, string>; body: unknown };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params[k]);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => "/argus/data");
vi.stubGlobal("useBuildRoot", () => "/builds/code");

type Handler = (e: Ev) => Promise<unknown>;
const commands = (await import("../api/proposals/[id]/commands.post.ts")).default as unknown as Handler;
const one = (await import("../api/proposals/[id].get.ts")).default as unknown as (e: Ev) => { launchUrl: string | null; mint: string | null; status: string };
const { launchLinkFor } = await import("../utils/launch.ts");

const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const PREVIEW = "https://cat-coin.me.workers.dev";
const proposal = { narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat Coin", ticker: "CAT", description: "A cat coin", evidenceLinks: [] as string[] };

beforeEach(() => {
  store = Datastore.open(":memory:");
  delete process.env.ARGUS_NEWPAIRSPAM_URL;
  delete process.env.ARGUS_LAUNCH_LOGO_URL;
});

function seed(upTo: "new" | "built") {
  const id = store.createProposal(proposal).id;
  if (upTo === "built") {
    store.transition(id, "shortlisted", "operator");
    store.transition(id, "spec-drafted", "system");
    store.transition(id, "approved", "operator");
    store.transition(id, "building", "build");
    store.completeBuild(id, { previewUrl: PREVIEW });
  }
  return id;
}
const post = (id: number, body: unknown) => commands({ params: { id: String(id) }, body });
const get = (id: number) => one({ params: { id: String(id) }, body: undefined });
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ statusCode: 200 }), (e: { statusCode: number }) => e)) as { statusCode: number }).statusCode;

describe("GET /api/proposals/:id, the Launch link", () => {
  it("is present only for a built Proposal and carries the prefill query", () => {
    expect(get(seed("new")).launchUrl).toBeNull();
    const built = get(seed("built"));
    const u = new URL(built.launchUrl!);
    expect(u.origin).toBe("http://localhost:3000");
    expect(Object.fromEntries(u.searchParams)).toEqual({ name: "Cat Coin", symbol: "CAT", description: "A cat coin", website: PREVIEW });
  });

  it("uses ARGUS_NEWPAIRSPAM_URL and sends a configured logo as imageUrl", () => {
    const p = store.getProposal(seed("built"))!;
    const u = new URL(launchLinkFor(p, { ARGUS_NEWPAIRSPAM_URL: "https://np.example", ARGUS_LAUNCH_LOGO_URL: "https://cdn.example/l.png" })!);
    expect(u.origin).toBe("https://np.example");
    expect(u.searchParams.get("imageUrl")).toBe("https://cdn.example/l.png");
  });

  it("a base URL that is not http(s) gives a null launchUrl (no 500, no javascript: href) and is logged once", () => {
    process.env.ARGUS_NEWPAIRSPAM_URL = "javascript:alert(1)";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const id = seed("built");
      expect(get(id)).toMatchObject({ status: "built", launchUrl: null });
      expect(get(id).launchUrl).toBeNull();
      expect(spy.mock.calls.filter((c) => String(c[0]).includes("ARGUS_NEWPAIRSPAM_URL"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("is null once launched or dismissed", () => {
    const id = seed("built");
    store.markLaunched(id, MINT);
    expect(get(id)).toMatchObject({ launchUrl: null, status: "launched", mint: MINT });
  });
});

describe("POST /api/proposals/:id/commands, the Mark launched button", () => {
  it('{ type: "mark-launched", reason: <mint> } is accepted, queued and applied by the worker', async () => {
    const id = seed("built");
    expect(await post(id, { type: "mark-launched", reason: MINT })).toMatchObject({ type: "mark-launched", reason: MINT });
    expect(applyPending(store)).toBe(1);
    expect(get(id)).toMatchObject({ status: "launched", mint: MINT });
  });

  it("400 for a malformed mint, 409 for a Proposal that is not built, 404 for none", async () => {
    const id = seed("built");
    expect(await status(post(id, { type: "mark-launched", reason: "" }))).toBe(400);
    expect(await status(post(id, { type: "mark-launched", reason: "not-a-mint" }))).toBe(400);
    expect(await status(post(seed("new"), { type: "mark-launched", reason: MINT }))).toBe(409);
    expect(await status(post(999, { type: "mark-launched", reason: MINT }))).toBe(404);
    expect(store.pendingCommands()).toEqual([]);
  });

  it("409 with a clear message when the mint is already recorded on another Proposal, and the worker refuses it too", async () => {
    const first = seed("built");
    store.markLaunched(first, MINT);
    const second = seed("built");
    const err = (await post(second, { type: "mark-launched", reason: MINT }).catch((e: unknown) => e)) as { statusCode: number; statusMessage: string };
    expect(err.statusCode).toBe(409);
    expect(err.statusMessage).toContain(`Proposal ${first}`);
    // A command queued before the first one applied is still refused by the worker.
    store.enqueueCommand(second, "mark-launched", MINT);
    const errors: unknown[] = [];
    applyPending(store, (_c, e) => errors.push(e));
    expect(store.getProposal(second)).toMatchObject({ status: "built", mint: null });
    expect(store.listCommands().at(-1)).toMatchObject({ status: "rejected" });
    expect(store.getProposal(first)!.mint).toBe(MINT);
  });
});
