import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Datastore, buildLogPathFor } from "@argus/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Endpoint-level test for the Build log tail the details view polls: the real route handler, called with the query the UI
 * sends (`{ offset }` as strings, like a URL query). Only Nitro's auto-imported globals are stubbed.
 */
type Ev = { params: Record<string, string>; query: Record<string, string> };
let store: Datastore;
let dataDir: string;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params[k]);
vi.stubGlobal("getQuery", (e: Ev) => e.query);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => dataDir);

type Tail = { content: string; offset: number; size: number };
const tail = (await import("../api/proposals/[id]/build-log.get.ts")).default as unknown as (e: Ev) => Tail;
const call = (id: number, query: Record<string, string> = {}) => tail({ params: { id: String(id) }, query });

beforeEach(() => {
  store = Datastore.open(":memory:");
  dataDir = mkdtempSync(join(tmpdir(), "argus-buildlog-"));
});

const seed = () => store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: [] }).id;
const write = (id: number, text: string) => {
  const path = buildLogPathFor(dataDir, id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text);
};

describe("GET /api/proposals/:id/build-log, the details view tail", () => {
  it("is empty before the Build has written anything", () => {
    expect(call(seed())).toEqual({ content: "", offset: 0, size: 0 });
  });

  it("returns what the log holds from the offset the UI sends, and the offset to ask for next", () => {
    const id = seed();
    write(id, '{"type":"system"}\n');
    const first = call(id, { offset: "0" });
    expect(first).toEqual({ content: '{"type":"system"}\n', offset: 18, size: 18 });
    write(id, '{"type":"result"}\n');
    expect(call(id, { offset: String(first.offset) })).toEqual({ content: '{"type":"result"}\n', offset: 36, size: 36 });
    expect(call(id, { offset: "36" })).toEqual({ content: "", offset: 36, size: 36 });
  });

  it("never splits a multi-byte character across two reads", () => {
    const id = seed();
    write(id, "€".repeat(200 * 1024)); // 600 KiB of 3-byte characters: more than one chunk, and the chunk size is not a multiple of 3
    const first = call(id);
    const second = call(id, { offset: String(first.offset) });
    expect(first.content + second.content).toBe("€".repeat(first.content.length + second.content.length));
    expect(first.content).not.toContain("�");
    expect(second.content).not.toContain("�");
    expect(first.offset % 3).toBe(0);
  });

  it("restarts from the top when the offset is past the end (the log was replaced)", () => {
    const id = seed();
    write(id, "fresh log\n");
    expect(call(id, { offset: "5000" })).toMatchObject({ content: "fresh log\n", offset: 10 });
  });

  it("treats a missing or junk offset as 0", () => {
    const id = seed();
    write(id, "abc");
    expect(call(id, { offset: "banana" }).content).toBe("abc");
    expect(call(id, { offset: "-5" }).content).toBe("abc");
  });

  it("404 for an unknown Proposal", () => {
    expect(() => call(999)).toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});
