import { describe, expect, it } from "vitest";
import { clusterBootstrapDiff, newcombeDiff, seededRandom, wilson } from "./stats.ts";

describe("wilson", () => {
  it.each([
    [5, 10, 0.2366, 0.7634],
    [0, 10, 0, 0.2775],
    [10, 10, 0.7225, 1],
    [1, 100, 0.0018, 0.0545],
  ])("%i of %i is [%f, %f]", (k, n, low, high) => {
    const w = wilson(k, n);
    expect(w.low).toBeCloseTo(low, 3);
    expect(w.high).toBeCloseTo(high, 3);
  });

  it("knows nothing from no trials", () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("newcombeDiff", () => {
  it("matches Newcombe's published worked example, 56/70 against 48/80: (0.0524, 0.3339)", () => {
    const d = newcombeDiff(56, 70, 48, 80);
    expect(d.low).toBeCloseTo(0.0524, 3);
    expect(d.high).toBeCloseTo(0.3339, 3);
  });
});

describe("clusterBootstrapDiff", () => {
  it("is deterministic for a seed and includes zero when the clusters are the same as the baseline", () => {
    const clusters = Array.from({ length: 20 }, (_, i) => ({ k: i % 2, n: 4 }));
    const a = clusterBootstrapDiff(clusters, 0.125);
    expect(clusterBootstrapDiff(clusters, 0.125)).toEqual(a);
    expect(a!.low).toBeLessThan(0);
    expect(a!.high).toBeGreaterThan(0);
  });

  it("is wider than the token-level interval when the tokens of a cluster move together", () => {
    // Ten clusters of 50 tokens: five migrate entirely, five not at all. 250 of 500 looks precise token by token; it is ten draws.
    const clusters = Array.from({ length: 10 }, (_, i) => ({ k: i < 5 ? 50 : 0, n: 50 }));
    const boot = clusterBootstrapDiff(clusters, 0.5)!;
    const token = newcombeDiff(250, 500, 250, 500);
    expect(boot.high - boot.low).toBeGreaterThan((token.high - token.low) / 2);
    expect(boot.high - boot.low).toBeGreaterThan(0.3);
  });

  it("returns undefined with nothing to resample", () => {
    expect(clusterBootstrapDiff([], 0.1)).toBeUndefined();
  });
});

describe("seededRandom", () => {
  it("repeats for a seed and stays in [0, 1)", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
