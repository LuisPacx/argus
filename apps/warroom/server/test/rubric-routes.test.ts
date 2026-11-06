import { Datastore } from "@argus/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Endpoint-level tests for the Rubric editor (apps/warroom/app/pages/rubric.vue): the real route handlers, called with
 * the exact payload the page sends. Only Nitro's auto-imported globals are stubbed.
 */
type Ev = { params: Record<string, string>; body: unknown };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);

type Rubric = { version: number; dimensions: Array<{ key: string; description: string; weight: number }>; gateMinScore: number; versions?: number[] };
const get = (await import("../api/rubric.get.ts")).default as unknown as (e: Ev) => Rubric;
const put = (await import("../api/rubric.put.ts")).default as unknown as (e: Ev) => Promise<Rubric>;
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ statusCode: 200 }), (e: { statusCode: number }) => e)) as { statusCode: number }).statusCode;

beforeEach(() => {
  store = Datastore.open(":memory:");
});

/** The editor's save payload: what it loaded, with the Operator's edits applied. */
function payload() {
  const r = get({ params: {}, body: undefined });
  return { baseVersion: r.version, dimensions: r.dimensions.map(({ key, description, weight }) => ({ key, description, weight })), gateMinScore: r.gateMinScore };
}

describe("GET /api/rubric", () => {
  it("returns the seeded Rubric: five dimensions at equal weights, buildability as the gate", () => {
    const r = get({ params: {}, body: undefined });
    expect(r.dimensions.map((d) => d.key)).toEqual(["momentum", "novelty", "buildability", "hook", "legitimacy"]);
    expect(r).toMatchObject({ version: 1, gateDimension: "buildability", versions: [1] });
  });
});

describe("PUT /api/rubric, the editor payload { baseVersion, dimensions, gateMinScore }", () => {
  it("saves edited descriptions, weights and gate as version 2", async () => {
    const body = payload();
    body.dimensions[0] = { key: "momentum", description: "Growth", weight: 2 };
    body.gateMinScore = 6;
    expect(await put({ params: {}, body })).toMatchObject({ version: 2, gateMinScore: 6 });
    expect(get({ params: {}, body: undefined })).toMatchObject({ version: 2, versions: [2, 1] });
    expect(get({ params: {}, body: undefined }).dimensions[0]).toMatchObject({ description: "Growth", weight: 2 });
  });

  it("400 with a message for invalid input, and nothing is stored", async () => {
    const blank = payload();
    blank.dimensions[2] = { ...blank.dimensions[2]!, description: " " };
    expect(await status(put({ params: {}, body: blank }))).toBe(400);
    const emptyWeight = payload();
    emptyWeight.dimensions[0] = { ...emptyWeight.dimensions[0]!, weight: "" as unknown as number };
    await expect(put({ params: {}, body: emptyWeight })).rejects.toThrow(/momentum: weight/);
    expect(await status(put({ params: {}, body: { ...payload(), gateMinScore: 99 } }))).toBe(400);
    expect(await status(put({ params: {}, body: { ...payload(), dimensions: "x" } }))).toBe(400);
    expect(await status(put({ params: {}, body: { dimensions: [], gateMinScore: 5 } }))).toBe(400);
    expect(get({ params: {}, body: undefined }).version).toBe(1);
  });

  it("409 when saved from a stale version", async () => {
    const stale = payload();
    await put({ params: {}, body: { ...stale, gateMinScore: 7 } });
    expect(await status(put({ params: {}, body: { ...stale, gateMinScore: 8 } }))).toBe(409);
  });
});
