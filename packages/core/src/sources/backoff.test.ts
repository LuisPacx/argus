import { describe, expect, it } from "vitest";
import { BackoffSource } from "./backoff.ts";
import { HttpError } from "./http.ts";
import type { Signal, Source } from "./source.ts";

const signal: Signal = { id: "s:1", sourceId: "s", sourceLabel: "S", title: "t", summary: "", url: "", publishedAt: "1970-01-01T00:00:00.000Z" };

/** An inner Source that throws what it is told to, and counts how often it was really polled. */
function inner(outcomes: Array<Signal[] | Error>) {
  let polls = 0;
  const source: Source = {
    id: "s",
    label: "S",
    async poll() {
      const o = outcomes[polls++] ?? [signal];
      if (o instanceof Error) throw o;
      return o;
    },
  };
  return { source, polls: () => polls };
}

describe("BackoffSource", () => {
  const MIN = 60_000;
  const make = (outcomes: Array<Signal[] | Error>) => {
    let t = 0;
    const i = inner(outcomes);
    const b = new BackoffSource(i.source, { baseMs: 10 * MIN, maxMs: 60 * MIN, now: () => t });
    return { b, i, advance: (ms: number) => (t += ms) };
  };

  it("keeps the wrapped Source's id and label and passes polls through", async () => {
    const { b } = make([[signal]]);
    expect([b.id, b.label]).toEqual(["s", "S"]);
    expect(await b.poll()).toEqual([signal]);
  });

  it("rethrows the failure, then skips polling (returns nothing) until the backoff passes", async () => {
    const { b, i, advance } = make([new Error("boom")]);
    await expect(b.poll()).rejects.toThrow("boom");
    advance(9 * MIN);
    expect(await b.poll()).toEqual([]);
    expect(i.polls()).toBe(1);
    advance(2 * MIN);
    expect(await b.poll()).toEqual([signal]);
    expect(i.polls()).toBe(2);
  });

  it("doubles the wait on repeated failures, up to the cap", async () => {
    const { b, i, advance } = make([new Error("1"), new Error("2"), new Error("3"), new Error("4"), new Error("5")]);
    for (const wait of [10, 20, 40, 60, 60]) {
      await expect(b.poll()).rejects.toThrow();
      const before = i.polls();
      advance((wait - 1) * MIN);
      expect(await b.poll()).toEqual([]);
      expect(i.polls()).toBe(before);
      advance(MIN);
    }
  });

  it("forgets the backoff after a success", async () => {
    const { b, advance } = make([new Error("1"), [signal], new Error("2")]);
    await expect(b.poll()).rejects.toThrow();
    advance(10 * MIN);
    await b.poll();
    await expect(b.poll()).rejects.toThrow("2");
    advance(10 * MIN); // back to the base wait, not 20
    expect(await b.poll()).toEqual([signal]);
  });

  it("waits at least as long as the server's Retry-After, within the cap", async () => {
    const { b, i, advance } = make([new HttpError("429", 429, 30 * MIN), new HttpError("429", 429, 24 * 60 * MIN)]);
    await expect(b.poll()).rejects.toThrow();
    advance(29 * MIN);
    expect(await b.poll()).toEqual([]);
    advance(2 * MIN);
    await expect(b.poll()).rejects.toThrow();
    advance(59 * MIN); // a day-long Retry-After is capped at maxMs
    expect(await b.poll()).toEqual([]);
    advance(2 * MIN);
    expect(await b.poll()).toEqual([signal]);
    expect(i.polls()).toBe(3);
  });
});
